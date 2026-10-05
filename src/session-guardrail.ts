import { getLaisoraConfiguration } from "./claude-settings";

import type { ClaudeConversation } from "./claudeHost";
import {
  decideActions,
  DEFAULT_GUARDRAIL_POLICY,
  foldGuardrail,
  type GuardrailDecision,
  type GuardrailExecutor,
  type GuardrailPolicy,
  type GuardrailSignal,
  type GuardrailState,
  decisionKey,
  normalizeAutoMaxLevel,
  classifyReportSendOutcome,
  planReportBatch,
  recordLedger,
  selectAutoActions,
  settleReportSend,
  touchedSignalIds,
  MAX_PENDING_REPORT_SIGNALS,
  MAX_SIGNALS,
  type GuardrailActionLedger,
  type GuardrailActionOutcome,
} from "./guardrail";
import { output } from "./host-context";
import type { DivergenceReport } from "./l3-divergence";
import type { SemanticModelPayload } from "./protocol";
import type { SemanticModel } from "./semantic-model";
import { SEMANTIC_MODEL_POST_INTERVAL_MS } from "./session-semantic";
import { STEER_LEVEL_BY_MODE, buildSteeringEnvelope, steeringInstruction, type SteeringMode } from "./steering-envelope";

const GUARDRAIL_TICK_MS = 15_000;

export interface SessionGuardrailHost {
  readonly title: string;
  readonly conversation: ClaudeConversation | null;
  guardrail: GuardrailState;
  readonly liveGuardrailSignalIds: Set<string>;
  readonly guardrailLiveSince?: number;
}

export class SessionGuardrail {
  private guardrailRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private guardrailTickTimer: ReturnType<typeof setTimeout> | null = null;
  notifiedGuardrailSignalIds = new Set<string>();
  guardrailLedger: GuardrailActionLedger = {};
  reportedSignalIds = new Set<string>();
  pendingReportSignalIds: string[] = [];
  lastReportedDroppedSignalCount = 0;
  generationSentSignalIds = new Set<string>();
  readonly guardrailExecutor: GuardrailExecutor = {
    warn: (decision, signals) => {
      for (const signal of signals) {
        output.appendLine(
          `[${this.host.title}] [guardrail] warn: signal=${signal.signalId} kind=${signal.kind} subject=${signal.subjectId}${signal.taskId ? ` task=${signal.taskId}` : ""} count=${signal.count} level=${decision.recommendedLevel}`
        );
      }
    },
    steer: (decision, signals, trigger) => this.sendSteering("steer", trigger, decision, signals),
    escalate: (decision, signals, trigger) => this.sendSteering("escalate", trigger, decision, signals),
  };

  constructor(
    private readonly host: SessionGuardrailHost,
    private readonly semanticDerivation: () =>
      | {
          model: SemanticModel;
          payload: SemanticModelPayload;
          divergenceReport?: DivergenceReport;
        }
      | undefined
  ) {}

  guardrailPolicy(): GuardrailPolicy {
    let raw: unknown = 1;
    try {
      raw = getLaisoraConfiguration().get<unknown>("guardrail.autoMaxLevel", 1);
    } catch {
      raw = 1;
    }
    return {
      ...DEFAULT_GUARDRAIL_POLICY,
      autoMaxLevel: normalizeAutoMaxLevel(raw, DEFAULT_GUARDRAIL_POLICY.autoMaxLevel),
    };
  }

  private sendSteering(
    mode: SteeringMode,
    trigger: "auto" | "manual",
    decision: GuardrailDecision,
    signals: GuardrailSignal[]
  ): GuardrailActionOutcome {
    const level = STEER_LEVEL_BY_MODE[mode];
    const summaries = signals.map((s) => ({
      signalId: s.signalId,
      kind: s.kind,
      target: s.target,
      subjectId: s.subjectId,
      ...(s.taskId !== undefined ? { taskId: s.taskId } : {}),
      count: s.count,
      confidence: s.confidence,
      firstAt: s.firstAt,
      lastAt: s.lastAt,
      ...(s.evidence.lostMs !== undefined ? { lostMs: s.evidence.lostMs } : {}),
    }));
    const key = decisionKey(decision);
    const envelope = buildSteeringEnvelope({
      schema: "gs1",
      mode,
      level,
      issuedAt: Date.now(),
      trigger,
      decision: {
        key,
        signalIds: [...decision.signalIds],
        ...(decision.taskId !== undefined ? { taskId: decision.taskId } : {}),
        recommendedLevel: decision.recommendedLevel,
        autoLevel: decision.autoLevel,
      },
      signals: summaries,
      instruction: steeringInstruction(mode, summaries),
    });
    const conv = this.host.conversation;
    const result =
      conv !== null && !conv.isClosed
        ? conv.sendSteeringEnvelope(envelope)
        : ({ ok: false, reason: "closed", message: "会話が未接続です。", transient: true } as const);
    output.appendLine(
      `[${this.host.title}] [guardrail] ${mode}: key=${key} level=${level} trigger=${trigger} ok=${result.ok}${result.ok ? "" : ` reason=${result.reason}`}`
    );
    return result.ok
      ? { ok: true, message: `${mode} を投入しました（Level ${level}・queued。モデルが次の tool 境界か次ターンで読む）` }
      : { ok: false, reason: result.reason, message: result.message.slice(0, 200), transient: result.transient };
  }

  executeGuardrailAction(
    action: "steer" | "escalate",
    trigger: "auto" | "manual",
    decision: GuardrailDecision,
    signals: GuardrailSignal[]
  ): GuardrailActionOutcome {
    const level = STEER_LEVEL_BY_MODE[action];
    const fn = action === "steer" ? this.guardrailExecutor.steer : this.guardrailExecutor.escalate;
    const outcome: GuardrailActionOutcome = fn
      ? fn.call(this.guardrailExecutor, decision, signals, trigger)
      : { ok: false, reason: "unsupported", message: "executor が実装されていません" };
    if (outcome.ok || outcome.transient !== true) {
      this.guardrailLedger = recordLedger(this.guardrailLedger, decision.signalIds, level);
    }
    return outcome;
  }

  private autoExecuteGuardrail(decisions: readonly GuardrailDecision[]): void {
    const conv = this.host.conversation;
    const running = conv !== null && !conv.isClosed && conv.state === "running";
    for (const planned of selectAutoActions(decisions, this.host.guardrail.signals, (s) => this.host.liveGuardrailSignalIds.has(s.signalId), this.guardrailLedger, running)) {
      this.executeGuardrailAction(planned.action, "auto", planned.decision, planned.signals);
    }
  }

  private sendPendingGuardrailReports(): void {
    const batch = planReportBatch(
      this.host.guardrail.signals,
      this.host.liveGuardrailSignalIds,
      this.reportedSignalIds,
      this.pendingReportSignalIds,
      this.host.guardrail
    );
    this.pendingReportSignalIds = batch.pending;
    if (batch.droppedPendingCount > 0) {
      output.appendLine(
        `[${this.host.title}] [guardrail] report pending overflow: dropped ${batch.droppedPendingCount} oldest signals (cap=${MAX_PENDING_REPORT_SIGNALS})`
      );
    }
    if (batch.send.length === 0) return;
    const sendSummaries = batch.send;
    const sendIds = sendSummaries.map((s) => s.signalId);
    const key = [...sendIds].sort().join(",");
    const envelope = buildSteeringEnvelope({
      schema: "gs1",
      mode: "report",
      level: 2,
      issuedAt: Date.now(),
      trigger: "auto",
      decision: {
        key,
        signalIds: sendIds,
        recommendedLevel: 0,
        autoLevel: 0,
      },
      signals: sendSummaries,
      instruction: steeringInstruction("report", sendSummaries),
    });
    const conv = this.host.conversation;
    const result =
      conv !== null && !conv.isClosed
        ? conv.sendReportEnvelope(envelope)
        : ({ ok: false, reason: "closed", message: "会話が未接続です。", transient: true } as const);
    const outcome = classifyReportSendOutcome(result);
    if (outcome.kind === "sent") {
      this.generationSentSignalIds = new Set(sendIds);
    }
    const settled = settleReportSend(
      sendIds,
      outcome,
      this.reportedSignalIds,
      this.pendingReportSignalIds
    );
    this.reportedSignalIds = settled.reportedSignalIds;
    this.pendingReportSignalIds = settled.pendingSignalIds;
    if (settled.droppedPendingCount > 0) {
      output.appendLine(
        `[${this.host.title}] [guardrail] report pending overflow: dropped ${settled.droppedPendingCount} oldest signals (cap=${MAX_PENDING_REPORT_SIGNALS})`
      );
    }
    if (settled.logLine) {
      output.appendLine(`[${this.host.title}] ${settled.logLine}`);
    }
  }

  settleConversationLost(): void {
    if (this.generationSentSignalIds.size === 0) return;
    const sent = [...this.generationSentSignalIds];
    this.generationSentSignalIds.clear();
    const settled = settleReportSend(
      sent,
      "conversation_lost",
      this.reportedSignalIds,
      this.pendingReportSignalIds
    );
    this.reportedSignalIds = settled.reportedSignalIds;
    this.pendingReportSignalIds = settled.pendingSignalIds;
    if (settled.droppedPendingCount > 0) {
      output.appendLine(
        `[${this.host.title}] [guardrail] report pending overflow: dropped ${settled.droppedPendingCount} oldest signals (cap=${MAX_PENDING_REPORT_SIGNALS})`
      );
    }
    if (settled.logLine) {
      output.appendLine(`[${this.host.title}] ${settled.logLine}`);
    }
  }

  clearGuardrailRefreshTimer(): void {
    if (this.guardrailRefreshTimer !== null) {
      clearTimeout(this.guardrailRefreshTimer);
      this.guardrailRefreshTimer = null;
    }
  }

  clearGuardrailTickTimer(): void {
    if (this.guardrailTickTimer !== null) {
      clearTimeout(this.guardrailTickTimer);
      this.guardrailTickTimer = null;
    }
  }

  scheduleGuardrailTick(): void {
    if (this.guardrailTickTimer !== null) return;
    this.guardrailTickTimer = setTimeout(() => {
      this.guardrailTickTimer = null;
      const conv = this.host.conversation;
      if (conv && conv.state === "running" && this.host.guardrailLiveSince !== undefined) {
        try {
          const before = this.host.guardrail;
          this.host.guardrail = foldGuardrail(this.host.guardrail, {
            type: "tick",
            now: Date.now(),
            idleSince: conv.lastRecordReceivedAt,
          });
          if (this.host.guardrail !== before) {
            for (const id of touchedSignalIds(before, this.host.guardrail)) this.host.liveGuardrailSignalIds.add(id);
          }
          if (this.host.guardrail !== before || this.pendingReportSignalIds.length > 0) {
            this.scheduleGuardrailRefresh();
          }
        } catch (error) {
          output.appendLine(`[${this.host.title}] Guardrail tick failed: ${String(error)}`);
        }
        this.scheduleGuardrailTick();
      }
    }, GUARDRAIL_TICK_MS);
  }

  scheduleGuardrailRefresh(): void {
    if (this.guardrailRefreshTimer !== null) return;
    this.guardrailRefreshTimer = setTimeout(() => {
      this.guardrailRefreshTimer = null;
      try {
        const derivation = this.semanticDerivation();
        if (derivation?.divergenceReport !== undefined) {
          this.host.guardrail = foldGuardrail(this.host.guardrail, {
            type: "divergence",
            report: derivation.divergenceReport,
            assignments: derivation.model.assignments,
          });
        }
        if (this.host.guardrail.droppedSignalCount > this.lastReportedDroppedSignalCount) {
          const delta = this.host.guardrail.droppedSignalCount - this.lastReportedDroppedSignalCount;
          this.lastReportedDroppedSignalCount = this.host.guardrail.droppedSignalCount;
          output.appendLine(
            `[${this.host.title}] [guardrail] dropped ${delta} signal(s) at detection (total=${this.host.guardrail.droppedSignalCount}, cap=${MAX_SIGNALS})`
          );
        }
        if (this.host.guardrailLiveSince !== undefined) {
          for (const s of this.host.guardrail.signals) {
            if (s.confidence === "divergence" && s.lastAt > this.host.guardrailLiveSince) this.host.liveGuardrailSignalIds.add(s.signalId);
          }
        }
        const decisions = decideActions(this.host.guardrail, this.guardrailPolicy());
        if (this.host.guardrailLiveSince !== undefined) {
          for (const decision of decisions) {
            const liveSignals = this.host.guardrail.signals.filter(
              (s) => decision.signalIds.includes(s.signalId) && this.host.liveGuardrailSignalIds.has(s.signalId)
            );
            if (liveSignals.length === 0) continue;
            if (decision.autoLevel >= 1) {
              const eligibleSignals = liveSignals.filter((s) => !this.notifiedGuardrailSignalIds.has(s.signalId));
              if (eligibleSignals.length > 0) {
                this.guardrailExecutor.warn(decision, eligibleSignals);
                for (const s of eligibleSignals) {
                  this.notifiedGuardrailSignalIds.add(s.signalId);
                }
              }
            }
          }
          this.autoExecuteGuardrail(decisions);
          this.sendPendingGuardrailReports();
        }
      } catch (error) {
        output.appendLine(`[${this.host.title}] Guardrail refresh failed: ${String(error)}`);
      }
    }, SEMANTIC_MODEL_POST_INTERVAL_MS);
  }
}
