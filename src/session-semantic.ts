import { getLaisoraConfiguration } from "./claude-settings";
import { projectPlanUsage, summarizeMainTokens, type PlanUsage } from "./plan-usage";
import * as l10n from "@vscode/l10n";
import { deriveFailureSummary } from "./exec-log-marks";
import { readSessionExternalRuns, type ExternalRunRecord, type SessionExternalRuns } from "./orchestration-external";
import { deriveRoleSummary, type ExternalRunsCoverage } from "./role-summary";
import {
  emptyRosterEvidence,
  hasInjectedRoster,
  mergeRosterEvidence,
  readRosterEvidence,
  writeRosterEvidence,
  type RosterEvidence,
} from "./roster-evidence";

import { projectAnalysisFactsView, projectSummaryAnalysis } from "./analysis-facts-view";
import type { SemanticEvidenceIndex } from "./evidence-index";
import { output } from "./host-context";
import { deriveL3 } from "./l3-analysis";
import { deriveDivergences, type DivergenceReport } from "./l3-divergence";
import type { LlmDiagnosticsAudience } from "./llm-report";
import { projectDivergences, projectSemanticModel } from "./projection";
import {
  type AnalysisPanelView,
  type L3ReportPayload,
  type RestoredAgent,
  type SemanticModelPayload,
  type TimeBucketsCoverage,
  type WorkModelPayload,
  projectWorkModel,
} from "./protocol";
import { deriveSemanticModel, type SemanticModel } from "./semantic-model";
import { deriveSessionFacts, type SessionFacts, type SessionFactsAccumulator } from "./session-facts";
import { inspectorSessionFile, isInSessionStore } from "./session-files";
import type { Session } from "./extension";
import type { LearningFacts } from "./learning";
import type { SessionStore } from "./store-surfaces";
import { currentWorkBlock, deriveTimeBuckets, overlayLiveTimeBucketState, projectWorkBlockTokens, type TimeBucketState, type TimeBucketView } from "./time-buckets";
import { childSpansOf, readTranscriptTimeBucketsWithCoverage } from "./transcript-time-buckets";
import { findToolPlacement, type WorkCoverage, type WorkModelState } from "./work-model";

export const SEMANTIC_MODEL_POST_INTERVAL_MS = 1000;
const WORK_MODEL_POST_INTERVAL_MS = 120;
const TRANSCRIPT_TIME_BUCKETS_DELAY_MS = 1500;

export function semanticViewEnabled(): boolean {
  try {
    return (
      getLaisoraConfiguration().get<boolean>("workLog.semanticView", true) !==
      false
    );
  } catch {
    return true;
  }
}

export function llmAnalysisEnabled(): boolean {
  try {
    return (
      getLaisoraConfiguration().get<boolean>("workLog.llmAnalysis", true) ===
      true
    );
  } catch {
    return false;
  }
}

export function llmDiagnosticsAudience(): LlmDiagnosticsAudience {
  try {
    return getLaisoraConfiguration()
      .get<boolean>("workLog.llmAnalysisDiagnostics", false) === true
      ? "opt-in-diagnostics"
      : "off";
  } catch {
    return "off";
  }
}


function externalOf(conv: Session["conversation"]): ExternalRunRecord[] {
  return (conv?.orchestrationRuns ?? []).filter((run): run is ExternalRunRecord => run.kind === "external");
}

function mergeExternalRuns(first: readonly ExternalRunRecord[], second: readonly ExternalRunRecord[]): ExternalRunRecord[] {
  const seen = new Set<string>();
  const out: ExternalRunRecord[] = [];
  for (const run of [...first, ...second]) {
    if (run.runId !== undefined) {
      if (seen.has(run.runId)) continue;
      seen.add(run.runId);
    }
    out.push(run);
  }
  return out;
}

function deriveL3Payload(
  model: SemanticModel,
  evidence: SemanticEvidenceIndex,
  divergenceReport: DivergenceReport,
  facts?: SessionFacts,
  learning?: LearningFacts
): L3ReportPayload {
  const analysis = deriveL3(model, evidence);
  const divergences = projectDivergences(divergenceReport);
  return {
    analysis,
    divergences,
    ...(facts !== undefined ? { facts: projectAnalysisFactsView(facts, divergenceReport, learning) } : {}),
  };
}

interface DerivationFailure {
  stage: "model" | "metrics";
  detail: string;
}

export function derivationFailureLabel(stage: DerivationFailure["stage"]): string {
  switch (stage) {
    case "model":
      return l10n.t("Could not build the work state from the record");
    case "metrics":
      return l10n.t("Could not build the analysis metrics from the record");
  }
}

export class SessionSemantic {
  private workModelPostTimer: ReturnType<typeof setTimeout> | null = null;
  private semanticModelPostTimer: ReturnType<typeof setTimeout> | null = null;
  transcriptTimeBuckets: TimeBucketView | undefined = undefined;
  transcriptTimeBucketsCoverage: TimeBucketsCoverage | undefined = undefined;
  private transcriptTimeBucketsTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptTimeBucketsReading = false;
  transcriptTimeBucketsDirty = false;
  semanticMemo: {
    workModel: WorkModelState;
    evidenceIndex: SemanticEvidenceIndex;
    streamOpen: boolean;
    liveDelegationRev: number;
    sessionFacts: SessionFactsAccumulator;
    learningKey: string | undefined;
    restoredAgents: RestoredAgent[];
    derivation: {
      model: SemanticModel;
      payload: SemanticModelPayload;
      divergenceReport?: DivergenceReport;
    } | undefined;
    derivationError: DerivationFailure | null;
  } | null = null;
  semanticDerivationFailedLast = false;
  lastGoodSemanticPayload: { payload: SemanticModelPayload; logicalGeneration: number } | undefined;

  constructor(
    private readonly host: Session,
    private readonly store: SessionStore
  ) {}

  clearSemanticModelPostTimer(): void {
    if (this.semanticModelPostTimer !== null) {
      clearTimeout(this.semanticModelPostTimer);
      this.semanticModelPostTimer = null;
    }
    this.clearTranscriptTimeBucketsTimer();
  }

  clearTranscriptTimeBucketsTimer(): void {
    if (this.transcriptTimeBucketsTimer !== null) {
      clearTimeout(this.transcriptTimeBucketsTimer);
      this.transcriptTimeBucketsTimer = null;
    }
  }

  scheduleTranscriptTimeBuckets(): void {
    if (this.host.closed) return;
    if (this.transcriptTimeBucketsReading) {
      this.transcriptTimeBucketsDirty = true;
      return;
    }
    if (this.transcriptTimeBucketsTimer !== null) return;
    this.transcriptTimeBucketsTimer = setTimeout(() => {
      this.transcriptTimeBucketsTimer = null;
      void this.refreshTranscriptTimeBuckets();
    }, TRANSCRIPT_TIME_BUCKETS_DELAY_MS);
  }

  private async refreshTranscriptTimeBuckets(): Promise<void> {
    const file = inspectorSessionFile(this.host);
    if (file === null) return;
    const logicalGeneration = this.host.logicalGeneration;
    this.transcriptTimeBucketsReading = true;
    let view: TimeBucketView | undefined;
    let coverage: TimeBucketsCoverage | undefined;
    try {
      const read = await readTranscriptTimeBucketsWithCoverage(file, isInSessionStore, {
        conversationId: this.host.tabId,
        generation: this.host.generation,
      });
      view = read.view;
      coverage = read.coverage;
    } catch (error) {
      output.appendLine(`[${this.host.title}] transcript time buckets failed: ${String(error)}`);
      coverage = { sessionReadError: String(error) };
    } finally {
      this.transcriptTimeBucketsReading = false;
    }
    if (!this.host.closed && logicalGeneration === this.host.logicalGeneration) {
      if (coverage !== undefined) {
        output.appendLine(`[${this.host.title}] transcript time buckets degraded: ${JSON.stringify(coverage)}`);
      }
      const coverageChanged = JSON.stringify(coverage) !== JSON.stringify(this.transcriptTimeBucketsCoverage);
      this.transcriptTimeBucketsCoverage = coverage;
      if (view !== undefined) this.transcriptTimeBuckets = view;
      if (view !== undefined || coverageChanged) this.scheduleSemanticModelPost();
    }
    if (this.transcriptTimeBucketsDirty) {
      this.transcriptTimeBucketsDirty = false;
      this.scheduleTranscriptTimeBuckets();
    }
  }

  projectedWorkModel(): WorkModelPayload {
    const model = projectWorkModel(this.host.workModel, this.host.restoredAgents);
    const time = this.host.evidenceIndex.timeBuckets;
    const block = currentWorkBlock(time);
    if (block) {
      const state = this.host.workModel;
      const approvalToolIds = this.host.conversation?.pendingApprovalToolUseIds ?? [];
      const approvalTools = new Set(approvalToolIds);
      const liveIds = new Set([...state.runningToolUseIds, ...state.runningAgentToolUseIds,
        ...Object.values(state.backgroundTasks).filter(task => task.terminal === undefined).map(task => task.toolUseId)]);
      const children = new Map<string, string[]>();
      for (const id of liveIds) {
        const tool = findToolPlacement(state, id);
        if (tool && !tool.stale && tool.background === undefined && tool.parentToolUseId !== null) {
          const siblings = children.get(tool.parentToolUseId) ?? [];
          siblings.push(id);
          children.set(tool.parentToolUseId, siblings);
        }
      }
      const runnableById = new Map<string, boolean>();
      const runnable = (id: string): boolean => {
        const cached = runnableById.get(id);
        if (cached !== undefined) return cached;
        runnableById.set(id, false);
        const tool = findToolPlacement(state, id);
        const liveChildren = children.get(id) ?? [];
        const running = tool !== undefined && !tool.stale && tool.toolName !== "AskUserQuestion" && !approvalTools?.has(id) &&
          (tool.agentId === undefined || liveChildren.length === 0 || liveChildren.some(runnable));
        runnableById.set(id, running);
        return running;
      };
      const blocksForeground = (id: string): boolean => {
        const seen = new Set<string>();
        let tool = findToolPlacement(state, id);
        while (tool && !seen.has(tool.toolUseId)) {
          if (tool.background !== undefined) return false;
          seen.add(tool.toolUseId);
          tool = tool.parentToolUseId === null ? undefined : findToolPlacement(state, tool.parentToolUseId);
        }
        return true;
      };
      const detachedApprovals = approvalToolIds.filter(id => !blocksForeground(id)).length;
      const waiting = model.phases.reduce((count, phase) => count + phase.pendingApprovalCount, 0) > detachedApprovals ||
        approvalToolIds.some(blocksForeground) || [...liveIds].some(id => {
          const tool = findToolPlacement(state, id);
          return tool !== undefined && !tool.stale && tool.toolName === "AskUserQuestion" && blocksForeground(id);
        });
      const runningWork = [...liveIds].some(runnable);
      model.planContext = { blockId: block.blockId, text: block.text, start: block.start,
        end: Math.max(block.start, time.lastAt ?? block.start), running: state.turnActive && !waiting ||
          this.host.streamOpen() && runningWork };
    }
    const semanticDerivationFailed: WorkCoverage["semanticDerivationFailed"] | undefined =
      this.semanticDerivationFailedLast && semanticViewEnabled()
        ? this.hasLastGoodSemanticForThisGeneration()
          ? "stale"
          : "unavailable"
        : undefined;
    if (!this.host.hydrationCoverageUnconfirmed && semanticDerivationFailed === undefined) return model;
    return {
      ...model,
      coverage: {
        ...model.coverage,
        ...(this.host.hydrationCoverageUnconfirmed
          ? {
              summary: "prefix-truncated" as const,
              details: "prefix-truncated" as const,
              hydrationUnconfirmed: "failed" as const,
            }
          : {}),
        ...(semanticDerivationFailed !== undefined ? { semanticDerivationFailed } : {}),
      },
    };
  }

  private planUsageMemo: { facts: SessionFactsAccumulator; partition: string; usage: PlanUsage } | undefined;
  private displayedTimeMemo: { generation: number; state: TimeBucketState; transcript: TimeBucketView | undefined;
    streamOpen: boolean; liveDelegationRev: number; restoredAgents: RestoredAgent[]; view: TimeBucketView } | undefined;

  private displayedTimeBuckets(): TimeBucketView | undefined {
    const state = this.host.evidenceIndex.timeBuckets;
    const streamOpen = this.host.streamOpen();
    const memo = this.displayedTimeMemo;
    const generation = this.host.logicalGeneration;
    if (memo?.generation === generation && memo.state === state && memo.transcript === this.transcriptTimeBuckets
      && memo.streamOpen === streamOpen && memo.liveDelegationRev === this.host.liveDelegationRev
      && memo.restoredAgents === this.host.restoredAgents) return memo.view;
    try {
      const live = deriveTimeBuckets(state, { streamOpen, childSpans: childSpansOf(this.host.restoredAgents),
        liveDelegationAgentIds: this.host.liveDelegationAgentIds });
      const measured = memo?.generation === generation && memo.transcript === this.transcriptTimeBuckets ? memo.view : this.transcriptTimeBuckets;
      const view = this.transcriptTimeBuckets === undefined || measured === undefined ? live : overlayLiveTimeBucketState(measured, live);
      this.displayedTimeMemo = { generation, state, transcript: this.transcriptTimeBuckets, streamOpen,
        liveDelegationRev: this.host.liveDelegationRev, restoredAgents: this.host.restoredAgents, view };
      return view;
    } catch (error) {
      output.appendLine(`[${this.host.title}] displayed time buckets failed: ${String(error)}`);
      return memo?.generation === generation ? memo.view : this.hasLastGoodSemanticForThisGeneration()
        ? this.lastGoodSemanticPayload?.payload.timeBuckets : undefined;
    }
  }

  projectedPlanUsage(blocks: readonly { blockId: string; start: number }[] = this.displayedTimeBuckets()?.blocks ?? this.host.evidenceIndex.timeBuckets.blocks): PlanUsage {
    const partition = JSON.stringify(blocks.map(block => [block.blockId, block.start]));
    const memo = this.planUsageMemo;
    if (memo?.facts === this.host.sessionFacts && memo.partition === partition) return memo.usage;
    const usage = projectPlanUsage(this.host.sessionFacts.planUsage, blocks);
    this.planUsageMemo = { facts: this.host.sessionFacts, partition, usage };
    return usage;
  }

  scheduleWorkModelPost(): void {
    if (this.host.resuming && this.host.hydration !== null) {
      this.host.hydration.workPostDirty = true;
      return;
    }
    if (this.workModelPostTimer !== null) return;
    this.workModelPostTimer = setTimeout(() => {
      this.workModelPostTimer = null;
      this.store.post({ type: "planUsage", tabId: this.host.tabId,
        state: this.projectedPlanUsage() });
      this.store.post({
        type: "workModel",
        tabId: this.host.tabId,
        model: this.projectedWorkModel(),
      });
    }, WORK_MODEL_POST_INTERVAL_MS);
  }

  semanticDerivation(): {
    model: SemanticModel;
    payload: SemanticModelPayload;
    divergenceReport?: DivergenceReport;
  } | undefined {
    const streamOpen = this.host.streamOpen();
    const learning = this.host.learningFacts?.();
    const learningKey = JSON.stringify(learning);
    const memo = this.semanticMemo;
    if (
      memo !== null &&
      memo.workModel === this.host.workModel &&
      memo.evidenceIndex === this.host.evidenceIndex &&
      memo.streamOpen === streamOpen &&
      memo.liveDelegationRev === this.host.liveDelegationRev &&
      memo.sessionFacts === this.host.sessionFacts &&
      memo.learningKey === learningKey &&
      memo.restoredAgents === this.host.restoredAgents
    ) {
      return memo.derivation;
    }
    let derivation: {
      model: SemanticModel;
      payload: SemanticModelPayload;
      divergenceReport?: DivergenceReport;
    } | undefined;
    let derivationError: DerivationFailure | null = null;
    try {
      const model = deriveSemanticModel(this.host.workModel, this.host.evidenceIndex, {
        conversationId: this.host.tabId,
        streamOpen,
        liveDelegationAgentIds: this.host.liveDelegationAgentIds,
        childSpans: childSpansOf(this.host.restoredAgents),
      });
      let payload = projectSemanticModel(model);
      let divergenceReport: DivergenceReport | undefined;
      try {
        divergenceReport = deriveDivergences(model);
        const facts = deriveSessionFacts(this.host.sessionFacts, this.host.evidenceIndex, {
          eventLogTrimmed: (this.host.workModel.coverage.droppedEventCount ?? 0) > 0,
        });
        payload = { ...payload, l3: deriveL3Payload(model, this.host.evidenceIndex, divergenceReport, facts, learning) };
      } catch (error) {
        derivationError = { stage: "metrics", detail: String(error) };
        output.appendLine(`[${this.host.title}] L3 derivation failed: ${derivationError.detail}`);
      }
      derivation = { model, payload, divergenceReport };
    } catch (error) {
      derivationError = { stage: "model", detail: String(error) };
      output.appendLine(`[${this.host.title}] SemanticModel derivation failed: ${derivationError.detail}`);
      derivation = undefined;
    }
    this.semanticMemo = {
      workModel: this.host.workModel,
      evidenceIndex: this.host.evidenceIndex,
      streamOpen,
      liveDelegationRev: this.host.liveDelegationRev,
      sessionFacts: this.host.sessionFacts,
      learningKey,
      restoredAgents: this.host.restoredAgents,
      derivation,
      derivationError,
    };
    this.semanticDerivationFailedLast = derivationError?.stage === "model";
    return derivation;
  }

  semanticBasePayload(): SemanticModelPayload | undefined {
    return this.semanticDerivation()?.payload;
  }

  semanticDerivationFailure(): DerivationFailure | null {
    this.semanticDerivation();
    return this.semanticMemo?.derivationError ?? null;
  }

  semanticModelPayload(): SemanticModelPayload | undefined {
    const base = this.semanticBasePayload();
    const timeBuckets = base === undefined ? undefined : this.displayedTimeBuckets();
    const overlaid = base !== undefined && timeBuckets !== undefined ? { ...base, timeBuckets } : base;
    const withCoverage =
      overlaid !== undefined && this.transcriptTimeBucketsCoverage !== undefined
        ? { ...overlaid, timeBucketsCoverage: this.transcriptTimeBucketsCoverage }
        : overlaid;
    const withUsage = withCoverage?.timeBuckets ? { ...withCoverage, timeBuckets: projectWorkBlockTokens(withCoverage.timeBuckets,
      this.projectedPlanUsage(withCoverage.timeBuckets.blocks)) } : withCoverage;
    const payload = this.attachLlm(withUsage, base);
    if (payload === undefined) return undefined;
    const work = projectWorkModel(this.host.workModel, this.host.restoredAgents);
    const conv = this.host.conversation;
    return {
      ...payload,
      roleSummary: deriveRoleSummary({
        phases: work.phases,
        unlinkedAgents: work.unlinkedAgents,
        ...this.externalRuns(conv),
        rosterEvidence: this.rosterEvidence(),
      }),
      failureSummary: deriveFailureSummary(payload.execLogFindings ?? [], work.phases),
      summaryAnalysis: projectSummaryAnalysis(payload.execLogFindings, payload.l3?.llm),
      mainTokens: summarizeMainTokens(this.host.sessionFacts.planUsage),
    };
  }

  private externalRunsCache: {
    ownerId: string;
    conversation: Session["conversation"];
    persisted: readonly ExternalRunRecord[];
    coverage: ExternalRunsCoverage | undefined;
  } | undefined;

  externalRuns(conv: Session["conversation"]): { externalRuns: ExternalRunRecord[]; externalRunsCoverage?: ExternalRunsCoverage } {
    const live = externalOf(conv);
    const owner = this.host.ownerState?.kind === "pinned" ? this.host.ownerState.ownerId : undefined;
    const directory = this.store.orchestrationRunsDirectory;
    if (owner === undefined || directory === undefined) return { externalRuns: live };
    let cache = this.externalRunsCache;
    if (cache?.ownerId !== owner || cache.conversation !== conv) {
      const carried = cache?.ownerId === owner ? mergeExternalRuns(externalOf(cache.conversation), cache.persisted) : [];
      const next = { ownerId: owner, conversation: conv, persisted: carried, coverage: cache?.ownerId === owner ? cache.coverage : undefined };
      this.externalRunsCache = cache = next;
      this.externalRunsRead = readSessionExternalRuns(directory, owner)
        .catch((error: unknown): SessionExternalRuns => {
          output.appendLine(`[${this.host.title}] [orchestration-runs] read failed: ${String(error)}`);
          return { runs: [], unreadableLines: 0, readError: true };
        })
        .then((read) => {
          if (this.externalRunsCache !== next || this.host.closed) return;
          next.persisted = mergeExternalRuns(read.runs, next.persisted);
          next.coverage = read.unreadableLines > 0 || read.readError ? { unreadableLines: read.unreadableLines, readError: read.readError } : undefined;
          this.scheduleSemanticModelPost();
        });
    }
    const externalRuns = mergeExternalRuns(live, cache.persisted);
    return cache.coverage !== undefined ? { externalRuns, externalRunsCoverage: cache.coverage } : { externalRuns };
  }

  private externalRunsRead: Promise<void> = Promise.resolve();

  flushExternalRuns(): Promise<void> {
    return this.externalRunsRead;
  }

  private rosterEvidenceCache: { ownerId: string; persisted: RosterEvidence; serialized: string } | undefined;
  private rosterEvidenceWrite: Promise<void> = Promise.resolve();

  rosterEvidence(): RosterEvidence {
    const live = this.host.conversation?.rosterEvidence ?? emptyRosterEvidence();
    const owner = this.host.ownerState?.kind === "pinned" ? this.host.ownerState.ownerId : undefined;
    const directory = this.store.rosterEvidenceDirectory;
    if (owner === undefined || directory === undefined) return live;
    if (this.rosterEvidenceCache?.ownerId !== owner) {
      const persisted = readRosterEvidence(directory, owner, (line) => output.appendLine(`[${this.host.title}] ${line}`));
      this.rosterEvidenceCache = { ownerId: owner, persisted, serialized: JSON.stringify(persisted) };
    }
    const cache = this.rosterEvidenceCache;
    const merged = mergeRosterEvidence(cache.persisted, live);
    const serialized = JSON.stringify(merged);
    if (serialized !== cache.serialized && hasInjectedRoster(merged)) {
      cache.persisted = merged;
      cache.serialized = serialized;
      this.rosterEvidenceWrite = this.rosterEvidenceWrite
        .then(() => writeRosterEvidence(directory, owner, merged))
        .catch((error: unknown) => {
          cache.serialized = "";
          output.appendLine(`[${this.host.title}] [roster-evidence] write failed: ${String(error)}`);
        });
    }
    return merged;
  }

  flushRosterEvidence(): Promise<void> {
    return this.rosterEvidenceWrite;
  }

  semanticModelPostPayload(): SemanticModelPayload | undefined {
    const payload = this.semanticModelPayload();
    if (payload !== undefined) {
      this.lastGoodSemanticPayload = { payload, logicalGeneration: this.host.logicalGeneration };
      return payload;
    }
    const last = this.lastGoodSemanticPayload;
    if (!this.semanticDerivationFailedLast || last === undefined || last.logicalGeneration !== this.host.logicalGeneration) {
      return undefined;
    }
    const llm = this.attachLlm(last.payload, last.payload)?.l3?.llm;
    const attached = llm && "attached" in llm ? llm.attached : undefined;
    const staleLlm = attached && llm ? { ...llm, attached: { ...attached, freshness: "stale" as const } } : llm;
    return {
      ...last.payload,
      summaryAnalysis: projectSummaryAnalysis(undefined, staleLlm),
      coverage: { ...last.payload.coverage, base: { ...last.payload.coverage.base, semanticDerivationFailed: "stale" } },
    };
  }

  private hasLastGoodSemanticForThisGeneration(): boolean {
    return this.lastGoodSemanticPayload?.logicalGeneration === this.host.logicalGeneration;
  }

  private attachLlm(
    base: SemanticModelPayload | undefined,
    freshnessBase: SemanticModelPayload | undefined
  ): SemanticModelPayload | undefined {
    if (base?.l3 === undefined || freshnessBase === undefined) return base;
    if (!llmAnalysisEnabled()) {
      return { ...base, l3: { ...base.l3, llm: { state: "disabled" } } };
    }
    let panelView: AnalysisPanelView;
    if (this.host.llmRun !== null) {
      const attached = this.host.analysisStore.buildAttachedAnalysisView(freshnessBase);
      panelView = attached ? { state: "running", attached } : { state: "running" };
    } else if (this.host.lastAttemptFailedReason !== null) {
      const attached = this.host.analysisStore.buildAttachedAnalysisView(freshnessBase);
      panelView = attached
        ? { state: "attemptFailed", reason: this.host.lastAttemptFailedReason, attached }
        : { state: "attemptFailed", reason: this.host.lastAttemptFailedReason };
    } else if (this.host.persistedArtifacts.length > 0) {
      const attached = this.host.analysisStore.buildAttachedAnalysisView(freshnessBase);
      panelView = attached ? { state: "attached", attached } : { state: "idle" };
    } else {
      panelView = { state: "idle" };
    }
    return { ...base, l3: { ...base.l3, llm: panelView } };
  }

  scheduleSemanticModelPost(): void {
    if (this.host.resuming && this.host.hydration !== null) {
      this.host.hydration.semanticPostDirty = true;
      return;
    }
    if (this.semanticModelPostTimer !== null) return;
    this.semanticModelPostTimer = setTimeout(() => {
      this.semanticModelPostTimer = null;
      if (!semanticViewEnabled()) return;
      const model = this.semanticModelPostPayload();
      if (model !== undefined) {
        this.store.post({ type: "semanticModel", tabId: this.host.tabId, model });
      } else if (this.semanticDerivationFailedLast) {
        this.store.post({ type: "workModel", tabId: this.host.tabId, model: this.projectedWorkModel() });
      }
    }, SEMANTIC_MODEL_POST_INTERVAL_MS);
  }
}
