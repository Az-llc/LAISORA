import { getLaisoraConfiguration } from "./claude-settings";
import { isChildCall } from "./spans";
import { projectPlanUsage, summarizeMainTokens, type PlanUsage } from "./plan-usage";
import * as l10n from "@vscode/l10n";
import { deriveExecLogFindings, deriveFailureSummary } from "./exec-log-marks";
import { readExternalRunsForSession, type ExternalRunRecord, type SessionExternalRuns } from "./orchestration-external";
import { resolveOrchestrationCacheTtl, resolveOrchestrationRoster } from "./orchestration-roster";
import type { CacheTtl } from "./claude-prices";
import { deriveAnalysisPlans, derivePlanPlacements, deriveRoleSummary, externalRunStart, type ExternalRunsCoverage, type PlanPlacement } from "./role-summary";
import {
  attributeSubagent,
  emptyRosterEvidence,
  hasInjectedRoster,
  mergeRosterEvidence,
  readRosterEvidence,
  readSourceRosterEvidence,
  type RosterSource,
  writeRosterEvidence,
  type RosterEvidence,
} from "./roster-evidence";

import { projectAnalysisFactsView, projectSummaryAnalysis } from "./analysis-facts-view";
import { type SemanticEvidenceIndex } from "./evidence-index";
import { output } from "./host-context";
import { deriveL3 } from "./l3-analysis";
import { deriveDivergences, type DivergenceReport } from "./l3-divergence";
import type { LlmDiagnosticsAudience } from "./llm-report";
import { projectDivergences, projectSemanticModel } from "./projection";
import {
  type AnalysisPanelView,
  type L3ReportPayload,
  type PlanContext,
  type RestoredAgent,
  type SemanticModelPayload,
  type TimeBucketsCoverage,
  type WorkModelPayload,
  flattenAgents,
  projectWorkModel,
  withSubagentModels,
} from "./protocol";
import { deriveSemanticModel, type SemanticModel } from "./semantic-model";
import { deriveSessionFacts, type ExternalRunCall, type SessionFacts, type SessionFactsAccumulator } from "./session-facts";
import { isInSessionStore, sessionTranscriptRef } from "./session-files";
import type { Session } from "./extension";
import type { SessionStore } from "./store-surfaces";
import { currentWorkBlock, deriveTimeBuckets, keyedValues, overlayLiveTimeBucketState, projectWorkBlockTokens, type ChildTranscriptSpan, type TimeBucketState, type TimeBucketView } from "./time-buckets";
import { planContextOf, planRowPeriods } from "./plan-steps";
import { readTranscriptTimeBucketsWithCoverage, transcriptTimeBucketsOf } from "./transcript-time-buckets";
import { transcriptReadStillCurrent, type SessionHistoryRead, type SubagentRestore } from "./session-transcript";
import { childSpansChangeRuns, findToolPlacement, type WorkCoverage, type WorkModelState } from "./work-model";

export const SEMANTIC_MODEL_POST_INTERVAL_MS = 1000;
const WORK_MODEL_POST_INTERVAL_MS = 120;
const TRANSCRIPT_TIME_BUCKETS_DELAY_MS = 1500;

export function semanticViewEnabled(): boolean {
  try {
    return (
      getLaisoraConfiguration().get<boolean>("workLog.semanticView")! !==
      false
    );
  } catch {
    return true;
  }
}

export function llmAnalysisEnabled(): boolean {
  try {
    return (
      getLaisoraConfiguration().get<boolean>("workLog.llmAnalysis")! ===
      true
    );
  } catch {
    return false;
  }
}

export function llmDiagnosticsAudience(): LlmDiagnosticsAudience {
  try {
    return getLaisoraConfiguration()
      .get<boolean>("workLog.llmAnalysisDiagnostics")! === true
      ? "opt-in-diagnostics"
      : "off";
  } catch {
    return "off";
  }
}


function configuredCacheTtls(): Map<string, CacheTtl> {
  const config = getLaisoraConfiguration();
  if (config.get<boolean>("orchestration.enabled") !== true) return new Map();
  const { roster } = resolveOrchestrationRoster(config.get<unknown>("orchestration.agents"));
  return new Map(roster.map((entry) => [entry.role, resolveOrchestrationCacheTtl(entry)]));
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
  facts?: SessionFacts
): L3ReportPayload {
  const analysis = deriveL3(model, evidence);
  const divergences = projectDivergences(divergenceReport);
  return {
    analysis,
    divergences,
    ...(facts !== undefined ? { facts: projectAnalysisFactsView(facts, divergenceReport) } : {}),
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

function placedPlanContext(context: PlanContext, placement: PlanPlacement): PlanContext {
  return { ...context, steps: context.steps?.map(step => ({ ...step, tokens: placement.tokens.get(step.key) ?? null })), placements: placement.placements,
    external: placement.external };
}

export class SessionSemantic {
  private workModelPostTimer: ReturnType<typeof setTimeout> | null = null;
  private semanticModelPostTimer: ReturnType<typeof setTimeout> | null = null;
  transcriptTimeBuckets: TimeBucketView | undefined = undefined;
  transcriptTimeBucketsCoverage: TimeBucketsCoverage | undefined = undefined;
  private transcriptTimeBucketsTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptTimeBucketsReading = false;
  private transcriptReadSeed: {
    file: string;
    sessionId: string;
    logicalGeneration: number;
    history: SessionHistoryRead;
    restored: SubagentRestore;
  } | undefined;
  transcriptTimeBucketsDirty = false;
  semanticMemo: {
    workModel: WorkModelState;
    evidenceIndex: SemanticEvidenceIndex;
    streamOpen: boolean;
    liveDelegationRev: number;
    sessionFacts: SessionFactsAccumulator;
    restoredAgents: RestoredAgent[];
    childSpans: readonly ChildTranscriptSpan[];
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

  seedTranscriptTimeBuckets(file: string, sessionId: string, history: SessionHistoryRead, restored: SubagentRestore): void {
    this.transcriptReadSeed = { file, sessionId, logicalGeneration: this.host.logicalGeneration, history, restored };
  }

  clearTranscriptTimeBucketsTimer(): void {
    this.transcriptReadSeed = undefined;
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
    const ref = sessionTranscriptRef(this.host);
    if (ref === null) return;
    const logicalGeneration = this.host.logicalGeneration;
    const seed = this.transcriptReadSeed;
    const childSpansAtStart = this.host.childSpans;
    this.transcriptReadSeed = undefined;
    this.transcriptTimeBucketsReading = true;
    let view: TimeBucketView | undefined;
    let coverage: TimeBucketsCoverage | undefined;
    let rosterSources: RosterSource[] | undefined;
    let childSpans: ChildTranscriptSpan[] | undefined;
    try {
      const ids = { conversationId: this.host.tabId, generation: this.host.generation };
      const seedCurrent = seed !== undefined && seed.file === ref.file && seed.sessionId === ref.sessionId &&
        seed.logicalGeneration === logicalGeneration &&
        await transcriptReadStillCurrent(seed.history, isInSessionStore) && await transcriptReadStillCurrent(seed.restored, isInSessionStore);
      const read = seedCurrent
        ? transcriptTimeBucketsOf(seed.history, seed.restored, ids)
        : await readTranscriptTimeBucketsWithCoverage(ref.file, isInSessionStore, ids, ref.sessionId);
      view = read.view;
      coverage = read.coverage;
      rosterSources = read.rosterSources;
      childSpans = read.childSpans;
    } catch (error) {
      output.appendLine(`[${this.host.title}] transcript time buckets failed: ${String(error)}`);
      coverage = { sessionReadError: String(error) };
    } finally {
      this.transcriptTimeBucketsReading = false;
    }
    if (!this.host.closed && logicalGeneration === this.host.logicalGeneration) {
      this.setRosterSources(ref.sessionId, rosterSources ?? []);
      if (coverage !== undefined) {
        output.appendLine(`[${this.host.title}] transcript time buckets degraded: ${JSON.stringify(coverage)}`);
      }
      const coverageChanged = JSON.stringify(coverage) !== JSON.stringify(this.transcriptTimeBucketsCoverage);
      this.transcriptTimeBucketsCoverage = coverage;
      if (view !== undefined) this.transcriptTimeBuckets = view;
      if (this.host.childSpans !== childSpansAtStart) this.transcriptTimeBucketsDirty = true;
      else if (childSpans !== undefined && childSpansChangeRuns(this.host.workModel, this.host.childSpans, childSpans)) {
        this.host.childSpans = childSpans;
        this.scheduleWorkModelPost();
      }
      if (view !== undefined || coverageChanged) this.scheduleSemanticModelPost();
    }
    if (this.transcriptTimeBucketsDirty) {
      this.transcriptTimeBucketsDirty = false;
      this.scheduleTranscriptTimeBuckets();
    }
  }

  projectedWorkModel(): WorkModelPayload {
    const model = projectWorkModel(this.host.workModel, this.host.restoredAgents, this.host.evidenceIndex.timeBuckets.blocks, this.host.childSpans);
    this.attachAgentRoles(model);
    // The displayed view, so the PLAN panel shows what GRAPH and ANALYSIS show, whether or not the semantic view is on.
    const displayed = this.displayedTimeBuckets();
    const time = displayed === undefined ? undefined : projectWorkBlockTokens(displayed, this.projectedPlanUsage(displayed.blocks));
    const block = time === undefined ? undefined : currentWorkBlock(time);
    if (time && block) {
      const state = this.host.workModel;
      const approvalToolIds = this.host.conversation?.pendingApprovalToolUseIds ?? [];
      const approvalTools = new Set(approvalToolIds);
      const liveIds = new Set([...state.runningToolUseIds, ...state.runningAgentToolUseIds,
        ...Object.values(state.backgroundTasks).filter(task => task.terminal === undefined).map(task => task.toolUseId)]);
      const children = new Map<string, string[]>();
      for (const id of liveIds) {
        const tool = findToolPlacement(state, id);
        if (tool && !tool.stale && tool.background === undefined && isChildCall(tool.parentToolUseId)) {
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
          tool = !isChildCall(tool.parentToolUseId) ? undefined : findToolPlacement(state, tool.parentToolUseId);
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
      const periods = planRowPeriods(time);
      const context = planContextOf(block, time.lastAt ?? block.start, state.turnActive && !waiting ||
        this.host.streamOpen() && runningWork, periods);
      const tools = this.host.sessionFacts.analysisTools;
      // Work posts stay cheap (B5-PLAN-cheap), so only this conversation's external runs, the ones the panel shows
      // (src/orchestration-view.ts#orchestrationViewForConversation), get a placement.
      const lanes = [...flattenAgents(model.phases, model.unlinkedAgents).flatMap(agent =>
          agent.toolUseId === undefined ? [] : [{ toolUseId: agent.toolUseId, start: agent.startedAt ?? null }]),
        ...(model.planTools ?? []).map(tool => ({ toolUseId: tool.id, start: tool.startedAt })),
        ...externalOf(this.host.conversation).flatMap(run => run.toolUseId === undefined ? [] : [{ toolUseId: run.toolUseId, start: externalRunStart(run, tools) }])];
      const placementOf = derivePlanPlacements(time, tools, lanes,
        { runs: this.knownExternalRuns(this.host.conversation), generationBoundaryAt: this.generationBoundaryAt() });
      model.planContext = placedPlanContext(context, placementOf(block.blockId));
      const earlierPlans = time.blocks.filter(value => value !== block && value.kind === "plan" && value.steps?.length)
        .map(value => placedPlanContext(planContextOf(value, value.end, false, periods), placementOf(value.blockId)));
      if (earlierPlans.length) model.earlierPlans = earlierPlans;
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
    streamOpen: boolean; liveDelegationRev: number; childSpans: readonly ChildTranscriptSpan[]; view: TimeBucketView } | undefined;

  private generationBoundaryAt(): number | undefined {
    return this.displayedTimeBuckets()?.generationBoundaryAt ?? this.host.evidenceIndex.timeBuckets.generationBoundaryAt;
  }

  private displayedTimeBuckets(): TimeBucketView | undefined {
    const state = this.host.evidenceIndex.timeBuckets;
    const streamOpen = this.host.streamOpen();
    const memo = this.displayedTimeMemo;
    const generation = this.host.logicalGeneration;
    if (memo?.generation === generation && memo.state === state && memo.transcript === this.transcriptTimeBuckets
      && memo.streamOpen === streamOpen && memo.liveDelegationRev === this.host.liveDelegationRev
      && memo.childSpans === this.host.childSpans) return memo.view;
    try {
      const live = deriveTimeBuckets(state, { streamOpen, childSpans: this.host.childSpans,
        liveDelegationAgentIds: this.host.liveDelegationAgentIds });
      const measured = memo?.generation === generation && memo.transcript === this.transcriptTimeBuckets ? memo.view : this.transcriptTimeBuckets;
      const view = this.transcriptTimeBuckets === undefined || measured === undefined ? live : overlayLiveTimeBucketState(measured, live);
      this.displayedTimeMemo = { generation, state, transcript: this.transcriptTimeBuckets, streamOpen,
        liveDelegationRev: this.host.liveDelegationRev, childSpans: this.host.childSpans, view };
      return view;
    } catch (error) {
      output.appendLine(`[${this.host.title}] displayed time buckets failed: ${String(error)}`);
      return memo?.generation === generation ? memo.view : this.hasLastGoodSemanticForThisGeneration()
        ? this.lastGoodSemanticPayload?.payload.timeBuckets : undefined;
    }
  }

  projectedPlanUsage(blocks: readonly { blockId: string; start: number; closedAt?: number }[] = this.displayedTimeBuckets()?.blocks ?? this.host.evidenceIndex.timeBuckets.blocks): PlanUsage {
    const partition = JSON.stringify(blocks.map(block => [block.blockId, block.start, block.closedAt]));
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
    const memo = this.semanticMemo;
    if (
      memo !== null &&
      memo.workModel === this.host.workModel &&
      memo.evidenceIndex === this.host.evidenceIndex &&
      memo.streamOpen === streamOpen &&
      memo.liveDelegationRev === this.host.liveDelegationRev &&
      memo.sessionFacts === this.host.sessionFacts &&
      memo.restoredAgents === this.host.restoredAgents &&
      memo.childSpans === this.host.childSpans
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
        childSpans: this.host.childSpans,
      });
      let payload = projectSemanticModel(model);
      let divergenceReport: DivergenceReport | undefined;
      try {
        const evidence = this.host.evidenceIndex;
        divergenceReport = deriveDivergences(model);
        const facts = deriveSessionFacts(this.host.sessionFacts, evidence, {
          eventLogTrimmed: (this.host.workModel.coverage.droppedEventCount ?? 0) > 0,
        });
        payload = { ...payload, l3: deriveL3Payload(model, evidence, divergenceReport, facts),
          execLogFindings: deriveExecLogFindings(evidence.execLogMarks.marks) };
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
      restoredAgents: this.host.restoredAgents,
      childSpans: this.host.childSpans,
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
    const generationBoundaryAt = this.generationBoundaryAt();
    const work = projectWorkModel(this.host.workModel, this.host.restoredAgents, this.host.evidenceIndex.timeBuckets.blocks, this.host.childSpans);
    const modelledTime = payload.timeBuckets === undefined ? undefined : withSubagentModels(payload.timeBuckets, flattenAgents(work.phases, work.unlinkedAgents));
    const conv = this.host.conversation;
    const roleExternal = this.roleExternalRuns(conv, generationBoundaryAt);
    const analysisPlans = deriveAnalysisPlans(payload.timeBuckets, deriveRoleSummary({
      phases: work.phases, unlinkedAgents: work.unlinkedAgents, ...roleExternal,
      rosterEvidence: this.rosterEvidence(), subagentUsage: this.host.sessionFacts.subagentUsage, timeBuckets: payload.timeBuckets,
      analysisTools: this.host.sessionFacts.analysisTools, generationBoundaryAt,
    }), this.host.sessionFacts.analysisTools, { usage: this.host.sessionFacts.subagentUsage, settings: configuredCacheTtls() });
    return {
      ...payload,
      ...(modelledTime === undefined ? {} : { timeBuckets: modelledTime }),
      analysisPlans,
      roleSummary: deriveRoleSummary({
        phases: work.phases,
        unlinkedAgents: work.unlinkedAgents,
        ...roleExternal,
        rosterEvidence: this.rosterEvidence(),
        subagentUsage: this.host.sessionFacts.subagentUsage,
        generationBoundaryAt,
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
    byToolUseId: ReadonlyMap<string, ExternalRunRecord>;
    coverage: ExternalRunsCoverage | undefined;
  } | undefined;

  roleExternalRuns(conv: Session["conversation"], generationBoundaryAt: number | undefined): { externalRuns: ExternalRunRecord[]; externalRunCalls: (ExternalRunCall & { running: boolean })[];
    externalRunsCoverage?: ExternalRunsCoverage } {
    const { externalRuns: known, externalRunsCoverage } = this.externalRuns(conv);
    const knownByToolUseId = new Map(known.flatMap(run => run.toolUseId === undefined ? [] : [[run.toolUseId, run] as const]));
    const recorded = this.externalRunsCache?.byToolUseId;
    const state = this.host.workModel;
    const live = new Set([...state.runningToolUseIds, ...Object.values(state.backgroundTasks).filter(task => task.terminal === undefined).map(task => task.toolUseId)]);
    const externalRuns: ExternalRunRecord[] = [];
    const externalRunCalls: (ExternalRunCall & { running: boolean })[] = [];
    const calls = this.host.sessionFacts.externalRunCalls;
    for (const call of calls === undefined ? [] : keyedValues(calls)) {
      if (call.rejectedBeforeRun || generationBoundaryAt !== undefined && call.startedAt < generationBoundaryAt) continue;
      const record = knownByToolUseId.get(call.toolUseId) ?? recorded?.get(call.toolUseId);
      if (record !== undefined) externalRuns.push(record);
      else externalRunCalls.push({ ...call, running: live.has(call.toolUseId) });
    }
    return externalRunsCoverage === undefined ? { externalRuns, externalRunCalls } : { externalRuns, externalRunCalls, externalRunsCoverage };
  }

  externalRuns(conv: Session["conversation"]): { externalRuns: ExternalRunRecord[]; externalRunsCoverage?: ExternalRunsCoverage } {
    const cache = this.loadExternalRuns(conv);
    if (cache === undefined) return { externalRuns: externalOf(conv) };
    const externalRuns = this.knownExternalRuns(conv);
    return cache.coverage !== undefined ? { externalRuns, externalRunsCoverage: cache.coverage } : { externalRuns };
  }

  // Starts the runs.jsonl read once per owner and conversation: when the owner is pinned (new or resumed session) and from
  // externalRuns; work posts only read what it has loaded (B5-PLAN-cheap).
  loadExternalRuns(conv: Session["conversation"]): { coverage: ExternalRunsCoverage | undefined } | undefined {
    const owner = this.host.ownerState?.kind === "pinned" ? this.host.ownerState.ownerId : undefined;
    const directory = this.store.orchestrationRunsDirectory;
    if (owner === undefined || directory === undefined) return undefined;
    let cache = this.externalRunsCache;
    if (cache?.ownerId === owner && cache.conversation !== conv) {
      cache.persisted = mergeExternalRuns(externalOf(cache.conversation), cache.persisted);
      cache.conversation = conv;
    } else if (cache?.ownerId !== owner) {
      const carried = cache?.ownerId === owner ? mergeExternalRuns(externalOf(cache.conversation), cache.persisted) : [];
      const next = { ownerId: owner, conversation: conv, persisted: carried, byToolUseId: cache?.byToolUseId ?? new Map<string, ExternalRunRecord>(),
        coverage: cache?.ownerId === owner ? cache.coverage : undefined };
      this.externalRunsCache = cache = next;
      this.externalRunsRead = readExternalRunsForSession(directory, owner).then(({ session, byToolUseId }): [SessionExternalRuns, ReadonlyMap<string, ExternalRunRecord>] => [session, byToolUseId])
        .catch((error: unknown): [SessionExternalRuns, ReadonlyMap<string, ExternalRunRecord>] => {
          output.appendLine(`[${this.host.title}] [orchestration-runs] read failed: ${String(error)}`);
          return [{ runs: [], unreadableLines: 0, readError: true }, next.byToolUseId];
        })
        .then(([read, byToolUseId]) => {
          if (this.externalRunsCache !== next || this.host.closed) return;
          next.persisted = mergeExternalRuns(read.runs, next.persisted);
          next.byToolUseId = byToolUseId;
          next.coverage = read.unreadableLines > 0 || read.readError ? { unreadableLines: read.unreadableLines, readError: read.readError } : undefined;
          this.scheduleSemanticModelPost();
          this.scheduleWorkModelPost();
        });
    }
    return cache;
  }

  private knownExternalRuns(conv: Session["conversation"]): ExternalRunRecord[] {
    const cache = this.externalRunsCache;
    const owner = this.host.ownerState?.kind === "pinned" ? this.host.ownerState.ownerId : undefined;
    return cache !== undefined && cache.ownerId === owner ? mergeExternalRuns(externalOf(conv), cache.persisted) : externalOf(conv);
  }

  private externalRunsRead: Promise<void> = Promise.resolve();

  flushExternalRuns(): Promise<void> {
    return this.externalRunsRead;
  }

  private agentRoles: { signature: string; roles: Map<string, string | null> } | undefined;

  attachAgentRoles(model: WorkModelPayload): void {
    const agents = flattenAgents(model.phases, model.unlinkedAgents);
    if (agents.length === 0) return;
    const live = this.host.conversation?.rosterEvidence;
    const owner = this.host.ownerState?.kind === "pinned" ? this.host.ownerState.ownerId : "";
    const signature = `${owner}|${this.sourceRoster?.ownerId ?? ""}|${live?.injections.length ?? 0}|${live?.starts.length ?? 0}`;
    if (this.agentRoles?.signature !== signature) this.agentRoles = { signature, roles: new Map() };
    const roles = this.agentRoles.roles;
    let evidence: RosterEvidence | undefined;
    for (const agent of agents) {
      const key = JSON.stringify([agent.toolUseId, agent.agentType ?? null, agent.transcriptAgentId ?? null, agent.startedAt ?? null]);
      let role = roles.get(key);
      if (role === undefined) {
        evidence ??= this.rosterEvidence();
        role = attributeSubagent(evidence, agent)?.definition.role ?? null;
        roles.set(key, role);
      }
      if (role !== null) agent.role = role;
    }
  }

  private rosterEvidenceCache: { ownerId: string; persisted: RosterEvidence; serialized: string } | undefined;
  private rosterEvidenceWrite: Promise<void> = Promise.resolve();
  private sourceRoster: { ownerId: string; evidence: RosterEvidence } | undefined;

  setRosterSources(ownerId: string, sources: readonly RosterSource[]): void {
    const directory = this.store.rosterEvidenceDirectory;
    this.sourceRoster = { ownerId, evidence: directory ? readSourceRosterEvidence(directory, sources) : emptyRosterEvidence() };
  }

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
    return this.sourceRoster?.ownerId === owner ? mergeRosterEvidence(this.sourceRoster.evidence, merged) : merged;
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
