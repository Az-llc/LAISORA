import * as l10n from "@vscode/l10n";
import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { IDLE_GAP_MS } from "./evidence-index";
import { createRecordUuidFilter, extractHumanUserText } from "./session-transcript";
import { CLAUDE_VOCABULARY } from "./work-model";

export interface AnalysisFinding {
  severity: "warn" | "notice";
  title: string;
  detail: string;
  at?: string;
}

export type ConclusionStatus = "complete" | "review" | "stop";

export type BaselineMetric = "toolFailureRate" | "turnDurationMs" | "outputTokens" | "agentTokenRatio" | "failureLoopFrequency";
type SparseBaselineMetric = "toolFailureRate" | "agentTokenRatio" | "failureLoopFrequency";

export interface SparseBaseline {
  occurrenceRate: number;
  sampleCount: number;
  nonzeroSampleCount: number;
  nonzeroMedian: number | null;
}

export interface PersonalBaseline {
  version: 5;
  calculatedAt: number;
  sessionCount: number;
  metrics: Record<BaselineMetric, number | null>;
  metricSampleCounts: Record<BaselineMetric, number>;
  metricNonzeroSampleCounts: Record<BaselineMetric, number>;
  sparseMetrics: Record<SparseBaselineMetric, SparseBaseline>;
}

export interface AnalysisMetric {
  key: BaselineMetric;
  value: number | null;
  baseline: number | null;
  multiple: number | null;
  occurrenceRate?: number;
  sampleCount?: number;
  nonzeroSampleCount?: number;
  nonzeroBaseline?: number | null;
}

export interface AnalysisEvidence {
  id: string;
  signal: "failure-loop" | "tool-failure" | "time-gap" | "token-skew" | "output-tokens" | "unfinished";
  title: string;
  detail: string;
  turn?: number;
  at?: string;
  metric?: AnalysisMetric;
}

export interface AnalysisAction {
  evidenceId?: string;
  text: string;
}

export interface AnalysisConclusion {
  status: ConclusionStatus;
  appliedRule: string;
  criteria: string[];
  evidence: AnalysisEvidence[];
  actions: AnalysisAction[];
}

export interface ToolStat {
  tool: string;
  count: number;
  fails: number;
  elapsedMs: number;
}

export interface SpanStat {
  name: string;
  count: number;
  fails: number;
  elapsedMs: number;
  agentTokens: number;
  agentTokensUnmeasured: "all" | "partial" | null;
}

export interface AnalysisCoverage {
  malformedLines: number;
  note: string | null;
}

export interface BaselineScanDegradation {
  rootFailed: boolean;
  unreadableProjects: number;
  unreadableSessions: number;
  unparsedSessions: number;
  readSessions: number;
}

export function baselineScanNote(
  mode: AnalysisReport["baselineMode"],
  scan: BaselineScanDegradation | undefined
): string | null {
  if (scan?.rootFailed === true) {
    return l10n.t("The baseline storage could not be read. Not comparing does not mean there are no other sessions. Check sync and permissions, then reopen.");
  }
  const parts: string[] = [];
  if (scan !== undefined) {
    if (scan.unreadableProjects > 0) parts.push(l10n.t("{0} projects", scan.unreadableProjects));
    if (scan.unreadableSessions > 0) parts.push(l10n.t("{0} records", scan.unreadableSessions));
    if (scan.unparsedSessions > 0) parts.push(l10n.t("{0} records (parse failed)", scan.unparsedSessions));
  }
  if (parts.length > 0 && scan !== undefined) {
    const basis =
      mode === "relative"
        ? l10n.t("The comparison covers only this range.")
        : l10n.t("Not enough records could be gathered for comparison, so absolute thresholds are used.");
    return l10n.t(
      "Only {0} baseline sessions could be read (unreadable: {1}). {2} Check sync and permissions, then reopen.",
      scan.readSessions,
      parts.join(l10n.t("; ")),
      basis
    );
  }
  if (mode === "relative") return null;
  if (mode === "absolute-fallback") {
    return l10n.t("Fewer than 20 valid baseline sessions, so multiples are not shown and absolute thresholds are used.");
  }
  return l10n.t("No baseline is available for comparison, so absolute thresholds are used.");
}

export interface AnalysisReport {
  title: string;
  startedAt: number | null;
  endedAt: number | null;
  totalElapsedMs: number;
  idleGapCount: number;
  idleMs: number;
  activeMs: number;
  idleGaps: Array<{ startMs: number; endMs: number; durMs: number }>;
  toolCalls: number;
  toolFails: number;
  outputTokens: number;
  agentCount: number;
  agentTokens: number;
  agentTokensUnmeasured: "all" | "partial" | null;
  agentTokensNote: string | null;
  model: string;
  turns: number;
  averageTurnDurationMs: number;
  failureLoopCount: number;
  baseline: PersonalBaseline | null;
  baselineMode: "relative" | "absolute-fallback" | "unavailable";
  baselineNote: string | null;
  coverage: AnalysisCoverage;
  conclusion: AnalysisConclusion;
  findings: AnalysisFinding[];
  tools: ToolStat[];
  skills: SpanStat[];
}

export interface BaselineSessionMetrics {
  turns: number;
  metrics: Record<BaselineMetric, number | null>;
}

interface ToolUse {
  id: string;
  name: string;
  input: unknown;
  ts: number;
  skill: string | null;
  turn: number;
  isError?: boolean;
  endTs?: number;
  resultText?: string;
}

const SPARSE_METRICS: ReadonlySet<BaselineMetric> = new Set(["toolFailureRate", "agentTokenRatio", "failureLoopFrequency"]);
export const MIN_BASELINE_SESSIONS = 5;

function errorFingerprint(use: ToolUse): string | null {
  const text = (use.resultText ?? "")
    .toLowerCase()
    .replace(/[a-f0-9]{8,}/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return text.length >= 8 ? `${use.name}:${text}` : null;
}

function actionFor(signal: AnalysisEvidence["signal"]): string {
  switch (signal) {
    case "failure-loop":
      return l10n.t("Retry from the failure point, changing the model or effort if needed.");
    case "tool-failure":
      return l10n.t("Check the tool's input, permissions, and dependency state, then retry.");
    case "time-gap":
      return l10n.t("Isolate the cause of the wait and consider splitting or parallelizing the work.");
    case "token-skew":
    case "output-tokens":
      return l10n.t("Review the subagent ratio, model, and effort, and split the work if needed.");
    case "unfinished":
      return l10n.t("Check the end state in the log and resume only if necessary.");
  }
}

function ts(o: any): number {
  const t = Date.parse(o?.timestamp ?? "");
  return Number.isFinite(t) ? t : 0;
}

function fmtTime(ms: number, locale: string | undefined): string {
  return new Date(ms).toLocaleTimeString(locale, { hour12: false });
}

function formatGap(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return minutes > 0 ? l10n.t("{0}m {1}s", minutes, seconds) : l10n.t("{0}s", seconds);
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function baselineSessionMetrics(report: AnalysisReport): BaselineSessionMetrics {
  const measuredTokens = report.agentTokens + report.outputTokens;
  return {
    turns: report.turns,
    metrics: {
      toolFailureRate: report.toolCalls > 0 ? report.toolFails / report.toolCalls : null,
      turnDurationMs: report.averageTurnDurationMs || null,
      outputTokens: report.outputTokens || null,
      agentTokenRatio: report.agentCount > 0 && report.agentTokens > 0 && measuredTokens > 0 ? report.agentTokens / measuredTokens : null,
      failureLoopFrequency: report.toolCalls >= 3 && report.turns > 0 ? report.failureLoopCount / report.turns : null,
    },
  };
}

export function calculatePersonalBaselineFromSessions(sessions: BaselineSessionMetrics[]): PersonalBaseline {
  const usable = sessions.filter((session) => session.turns > 0);
  const sparse = (key: SparseBaselineMetric): SparseBaseline => {
    const exposed = usable.map((session) => session.metrics[key]).filter((value): value is number => value !== null);
    const occurred = exposed.filter((value) => value > 0);
    return { occurrenceRate: exposed.length ? occurred.length / exposed.length : 0, sampleCount: exposed.length, nonzeroSampleCount: occurred.length, nonzeroMedian: occurred.length ? median(occurred) : null };
  };
  const continuous = (key: "turnDurationMs" | "outputTokens") => usable.map((session) => session.metrics[key]).filter((value): value is number => value !== null);
  const durations = continuous("turnDurationMs");
  const outputs = continuous("outputTokens");
  return {
    version: 5,
    calculatedAt: Date.now(),
    sessionCount: usable.length,
    metrics: { toolFailureRate: null, turnDurationMs: median(durations), outputTokens: median(outputs), agentTokenRatio: null, failureLoopFrequency: null },
    metricSampleCounts: { toolFailureRate: sparse("toolFailureRate").sampleCount, turnDurationMs: durations.length, outputTokens: outputs.length, agentTokenRatio: sparse("agentTokenRatio").sampleCount, failureLoopFrequency: sparse("failureLoopFrequency").sampleCount },
    metricNonzeroSampleCounts: { toolFailureRate: sparse("toolFailureRate").nonzeroSampleCount, turnDurationMs: durations.filter((value) => value > 0).length, outputTokens: outputs.filter((value) => value > 0).length, agentTokenRatio: sparse("agentTokenRatio").nonzeroSampleCount, failureLoopFrequency: sparse("failureLoopFrequency").nonzeroSampleCount },
    sparseMetrics: { toolFailureRate: sparse("toolFailureRate"), agentTokenRatio: sparse("agentTokenRatio"), failureLoopFrequency: sparse("failureLoopFrequency") },
  };
}

const SESSION_READ_CHUNK_BYTES = 1024 * 1024;

export async function forEachSessionLine(filePath: string, onLine: (line: string) => void, chunkBytes = SESSION_READ_CHUNK_BYTES): Promise<void> {
  const file = await open(filePath, "r");
  try {
    const chunk = Buffer.allocUnsafe(chunkBytes);
    let carry: Buffer[] = [];
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunkBytes, null);
      if (bytesRead === 0) break;
      const view = chunk.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const newline = view.indexOf(0x0a, start);
        if (newline === -1) break;
        const segment = view.subarray(start, newline);
        onLine(carry.length === 0 ? segment.toString("utf8") : Buffer.concat([...carry, segment]).toString("utf8"));
        carry = [];
        start = newline + 1;
      }
      if (start < bytesRead) carry.push(Buffer.from(view.subarray(start)));
    }
    onLine(Buffer.concat(carry).toString("utf8"));
  } finally {
    await file.close();
  }
}

export function analyzeSessionFile(
  filePath: string,
  baseline: PersonalBaseline | null = null,
  baselineScan?: BaselineScanDegradation,
  locale?: string
): AnalysisReport {
  const analyzer = sessionAnalyzer(baseline, baselineScan, locale);
  analyzer.next();
  for (const line of readFileSync(filePath, "utf8").split("\n")) analyzer.next(line);
  return analyzer.next(null).value as AnalysisReport;
}

export async function analyzeSessionFileAsync(
  filePath: string,
  baseline: PersonalBaseline | null = null,
  baselineScan?: BaselineScanDegradation,
  locale?: string
): Promise<AnalysisReport> {
  const analyzer = sessionAnalyzer(baseline, baselineScan, locale);
  analyzer.next();
  await forEachSessionLine(filePath, (line) => { analyzer.next(line); });
  return analyzer.next(null).value as AnalysisReport;
}

function* sessionAnalyzer(
  baseline: PersonalBaseline | null,
  baselineScan: BaselineScanDegradation | undefined,
  locale: string | undefined
): Generator<void, AnalysisReport, string | null> {
  const uses = new Map<string, ToolUse>();
  const order: ToolUse[] = [];
  let title = "";
  let model = "";
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  const timestamps: number[] = [];
  let outputTokens = 0;
  let turn = 0;
  let activeTurnStartedAt: number | null = null;
  const completedTurnDurations: number[] = [];
  let normalEnd = false;
  let currentSkill: string | null = null;

  const acceptRecord = createRecordUuidFilter();
  let malformedLines = 0;

  for (;;) {
    const line = yield;
    if (line === null) break;
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    if (!acceptRecord(o)) continue;
    const t = ts(o);
    if (t) {
      if (startedAt === null || t < startedAt) startedAt = t;
      if (endedAt === null || t > endedAt) endedAt = t;
      timestamps.push(t);
    }
    if (o.isSidechain) continue;

    const humanText = extractHumanUserText(o);
    if (humanText) {
      turn++;
      activeTurnStartedAt = t || activeTurnStartedAt;
      normalEnd = false;
      if (!title) title = humanText.split("\n")[0].slice(0, 60);
      currentSkill = null;
    }
    if (o.type === "assistant") {
      if (!model && typeof o.message?.model === "string") model = o.message.model;
      const u = o.message?.usage;
      if (u && typeof u.output_tokens === "number") outputTokens += u.output_tokens;
      const content = Array.isArray(o.message?.content) ? o.message.content : [];
      const hasToolUse = content.some((b: any) => b?.type === "tool_use");
      normalEnd = !hasToolUse && content.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
      if (normalEnd && activeTurnStartedAt !== null && t >= activeTurnStartedAt) {
        completedTurnDurations.push(t - activeTurnStartedAt);
        activeTurnStartedAt = null;
      }
      for (const b of content) {
        if (b?.type !== "tool_use" || typeof b.id !== "string") continue;
        const name = String(b.name ?? "?");
        const input = b.input ?? {};
        if (CLAUDE_VOCABULARY.task.has(name)) continue;
        if (name === "Skill" && input && typeof input === "object") {
          const s = (input as Record<string, unknown>).skill;
          if (typeof s === "string") currentSkill = s;
        }
        const use: ToolUse = { id: b.id, name, input, ts: t, skill: currentSkill, turn };
        uses.set(b.id, use);
        order.push(use);
      }
    }

    if (o.type === "user" && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const use = uses.get(b.tool_use_id);
        if (!use) continue;
        use.isError = b.is_error === true;
        use.endTs = t;
        use.resultText =
          typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((c: any) => c?.text ?? "").join(" ")
              : "";
      }
    }
  }

  const tools = new Map<string, ToolStat>();
  const skills = new Map<string, SpanStat>();
  let toolFails = 0;
  let agentCount = 0;
  let agentTokens = 0;
  let agentTokensMeasuredCount = 0;

  const spanAgentCalls = new Map<string, { agents: number; measured: number }>();
  const bump = (
    map: Map<string, SpanStat>, key: string, dur: number, fail: boolean, tok: number, agentMeasured: boolean | null
  ) => {
    const s = map.get(key) ?? { name: key, count: 0, fails: 0, elapsedMs: 0, agentTokens: 0, agentTokensUnmeasured: null };
    s.count++;
    if (fail) s.fails++;
    s.elapsedMs += dur;
    s.agentTokens += tok;
    if (agentMeasured !== null) {
      const c = spanAgentCalls.get(key) ?? { agents: 0, measured: 0 };
      c.agents++;
      if (agentMeasured) c.measured++;
      spanAgentCalls.set(key, c);
    }
    map.set(key, s);
  };

  for (const u of order) {
    const dur = u.endTs && u.endTs > u.ts ? u.endTs - u.ts : 0;
    const isAgent = CLAUDE_VOCABULARY.delegate.has(u.name);
    let tok = 0;
    let agentMeasured: boolean | null = null;
    if (isAgent) {
      agentCount++;
      agentMeasured = false;
      const m = /subagent_tokens[":\s]*(\d+)/.exec(u.resultText ?? "");
      if (m) {
        tok = Number(m[1]);
        agentTokens += tok;
        agentTokensMeasuredCount++;
        agentMeasured = true;
      }
    }
    if (u.isError) toolFails++;
    const t = tools.get(u.name) ?? { tool: u.name, count: 0, fails: 0, elapsedMs: 0 };
    t.count++;
    if (u.isError) t.fails++;
    t.elapsedMs += dur;
    tools.set(u.name, t);
    if (u.skill) bump(skills, u.skill, dur, !!u.isError, tok, agentMeasured);
  }
  for (const s of skills.values()) {
    const c = spanAgentCalls.get(s.name);
    s.agentTokensUnmeasured = c === undefined || c.measured === c.agents ? null : c.measured === 0 ? "all" : "partial";
  }

  const findings: AnalysisFinding[] = [];
  for (const t of tools.values()) {
    if (t.count >= 4 && t.fails / t.count >= 0.5) {
      findings.push({
        severity: "warn",
        title: l10n.t("Repeated failures of {0} — {2} of {1} calls failed, {3}s total", t.tool, t.count, t.fails, Math.round(t.elapsedMs / 1000)),
        detail: l10n.t("The same kind of failure keeps recurring. A persistent cause such as denial, permissions, or a wrong path is possible."),
      });
    }
  }
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1];
    const b = order[i];
    if (
      a.name === b.name &&
      a.isError &&
      b.isError &&
      JSON.stringify(a.input) === JSON.stringify(b.input)
    ) {
      findings.push({
        severity: "warn",
        title: l10n.t("Retry with identical input — {0} ×2 (exact match)", b.name),
        detail: l10n.t("A failed call was re-run with the same arguments and failed the same way. A sign of not learning from the failure."),
        at: `${fmtTime(a.ts, locale)} / ${fmtTime(b.ts, locale)}`,
      });
      break;
    }
  }
  const evidence: AnalysisEvidence[] = [];
  const addEvidence = (
    signal: AnalysisEvidence["signal"],
    title: string,
    detail: string,
    use: { turn: number; ts: number },
  ) => {
    evidence.push({
      id: `e${evidence.length + 1}`,
      signal,
      title,
      detail,
      turn: use.turn,
      at: fmtTime(use.ts, locale),
    });
  };

  const loopRootKeys = new Set<string>();
  const recordFailureLoop = (use: ToolUse, count: number, reason: string) => {
    const signature = errorFingerprint(use) ?? "unfingerprinted";
    const key = `${use.name}\u0000${signature}`;
    if (loopRootKeys.has(key)) return;
    loopRootKeys.add(key);
    addEvidence("failure-loop", `${use.name}: ${count} failed attempts`, `${reason} (same tool/error-signature cluster; one root only).`, use);
  };
  for (let i = 2; i < order.length; i++) {
    const a = order[i - 2]; const b = order[i - 1]; const c = order[i];
    if (!a.isError || !b.isError || !c.isError) continue;
    const sameTurn = a.turn === b.turn && b.turn === c.turn;
    const fa = errorFingerprint(a); const fb = errorFingerprint(b); const fc = errorFingerprint(c);
    const sameSignature = fa !== null && fa === fb && fb === fc;
    if (sameTurn || sameSignature) recordFailureLoop(c, 3, sameTurn ? "Three consecutive failures in the same turn" : "Three consecutive failures with the same signature");
  }
  const sameErrors = new Map<string, ToolUse[]>();
  for (const use of order) {
    if (!use.isError) continue;
    const key = errorFingerprint(use);
    if (key) (sameErrors.get(key) ?? sameErrors.set(key, []).get(key)!).push(use);
  }
  for (const uses of sameErrors.values()) {
    if (uses.length >= 5) recordFailureLoop(uses[uses.length - 1], uses.length, "Five or more failures with the same error signature");
  }
  for (const stat of tools.values()) {
    if (stat.fails === 0) continue;
    const use = order.find((candidate) => candidate.name === stat.tool && candidate.isError);
    if (!use) continue;
    addEvidence(
      "tool-failure",
      l10n.t("{1} failures in {0}", stat.tool, stat.fails),
      l10n.t("Matches the review criterion \"tool failures present\"."),
      use,
    );
  }

  const tokenTotalForSkew = agentTokens + outputTokens;
  if (tokenTotalForSkew > 0 && agentTokens / tokenTotalForSkew > 0.8) {
    const share = Math.round((agentTokens / tokenTotalForSkew) * 100);
    const use = order.find((candidate) => CLAUDE_VOCABULARY.delegate.has(candidate.name)) ?? order[0];
    if (use) {
      addEvidence(
        "token-skew",
        l10n.t("agentTokens are {0}% of generated tokens", share),
        l10n.t("Matches the review criterion \"agentTokens exceed 80% of all generated tokens\"."),
        use,
      );
    }
  }

  if (!normalEnd) {
    const use = order[order.length - 1] ?? { turn: Math.max(1, turn), ts: endedAt ?? Date.now() };
    addEvidence(
      "unfinished",
      l10n.t("Normal termination could not be confirmed"),
      l10n.t("The completion criterion requires none of the above signals and a normal termination."),
      use,
    );
  }

  const turns = Math.max(turn, completedTurnDurations.length);
  const averageTurnDurationMs = completedTurnDurations.length ? completedTurnDurations.reduce((total, duration) => total + duration, 0) / completedTurnDurations.length : 0;
  const failureLoopCount = loopRootKeys.size;
  const measuredTokens = agentTokens + outputTokens;
  const currentMetrics: Record<BaselineMetric, number | null> = {
    toolFailureRate: order.length ? toolFails / order.length : null,
    turnDurationMs: averageTurnDurationMs || null,
    outputTokens: outputTokens || null,
    agentTokenRatio: agentCount > 0 && agentTokens > 0 && measuredTokens > 0 ? agentTokens / measuredTokens : null,
    failureLoopFrequency: order.length >= 3 && turns ? failureLoopCount / turns : null,
  };
  const baselineMode: AnalysisReport["baselineMode"] = !baseline ? "unavailable" : "relative";
  const metric = (key: BaselineMetric): AnalysisMetric => {
    const value = currentMetrics[key];
    const sampleCount = SPARSE_METRICS.has(key)
      ? baseline?.sparseMetrics[key as SparseBaselineMetric]?.sampleCount ?? 0
      : baseline?.metricSampleCounts?.[key] ?? 0;
    const nonzeroSampleCount = baseline?.metricNonzeroSampleCounts?.[key] ?? 0;
    if (SPARSE_METRICS.has(key)) {
      const sparse = baseline?.sparseMetrics[key as SparseBaselineMetric];
      const nonzero = sparse?.nonzeroMedian ?? null;
      return { key, value, baseline: nonzero, multiple: value !== null && value > 0 && nonzero !== null && nonzero > 0 ? value / nonzero : null, occurrenceRate: sparse?.occurrenceRate, sampleCount, nonzeroSampleCount, nonzeroBaseline: nonzero };
    }
    const reference = baseline?.metrics[key] ?? null;
    return { key, value, baseline: reference, multiple: value !== null && reference !== null && reference > 0 ? value / reference : null, sampleCount, nonzeroSampleCount };
  };  const metrics: Record<BaselineMetric, AnalysisMetric> = { toolFailureRate: metric("toolFailureRate"), turnDurationMs: metric("turnDurationMs"), outputTokens: metric("outputTokens"), agentTokenRatio: metric("agentTokenRatio"), failureLoopFrequency: metric("failureLoopFrequency") };
  const absoluteMetric = (value: AnalysisMetric): string => {
    if (value.value === null) return l10n.t("Not measurable");
    switch (value.key) { case "toolFailureRate": return `${Math.round(value.value * 100)}%`; case "turnDurationMs": return formatGap(value.value); case "outputTokens": return `${Math.round(value.value).toLocaleString(locale)} tok`; case "agentTokenRatio": return `${Math.round(value.value * 100)}%`; case "failureLoopFrequency": return l10n.t("{0} per turn", value.value.toFixed(2)); }
  };
  const relativeMetric = (value: AnalysisMetric): string => {
    if (value.value === null) return "not measurable in this session";
    if ((value.sampleCount ?? 0) < MIN_BASELINE_SESSIONS) return `absolute fallback (exposure n=${value.sampleCount ?? 0})`;
    if (SPARSE_METRICS.has(value.key)) {
      const exposure = value.key === "toolFailureRate" ? l10n.t("tool-executing sessions") : value.key === "failureLoopFrequency" ? l10n.t("sessions executing 3+ tools") : l10n.t("agent-executing sessions");
      const occurrence = l10n.t("Occurs in {1}% of {0} (n={2})", exposure, Math.round((value.occurrenceRate ?? 0) * 100), value.sampleCount ?? 0);
      const size = value.multiple !== null ? l10n.t("{0}x the median when it occurs", value.multiple.toFixed(1)) : l10n.t("Median ratio when it occurs not measured");
      return l10n.t("{0} · {1}", occurrence, size);
    }
    return value.multiple !== null ? l10n.t("{0}x the baseline median (n={1})", value.multiple.toFixed(1), value.sampleCount ?? 0) : l10n.t("baseline comparison unavailable (n={0})", value.sampleCount ?? 0);
  };  const isAbnormal = (value: AnalysisMetric, fallback: boolean): boolean => {
    if (value.value === null) return false;
    if (!baseline || (value.sampleCount ?? 0) < MIN_BASELINE_SESSIONS || (value.nonzeroSampleCount ?? 0) < MIN_BASELINE_SESSIONS) return fallback;
    if (SPARSE_METRICS.has(value.key)) {
      const rareOccurrence = (value.occurrenceRate ?? 1) < 0.1;
      return value.value > 0 && (rareOccurrence || (value.multiple !== null && value.multiple >= 2));
    }
    return (value.multiple ?? 0) >= 2;
  };  const metricForSignal: Record<Exclude<AnalysisEvidence["signal"], "unfinished" | "time-gap">, AnalysisMetric> = { "failure-loop": metrics.failureLoopFrequency, "tool-failure": metrics.toolFailureRate, "token-skew": metrics.agentTokenRatio, "output-tokens": metrics.outputTokens };
  const fallbackForSignal: Record<keyof typeof metricForSignal, boolean> = { "failure-loop": failureLoopCount > 0, "tool-failure": toolFails > 0, "token-skew": measuredTokens > 0 && agentTokens / measuredTokens > 0.8, "output-tokens": false };
  const absoluteStopEvidence = evidence.filter((item) => item.signal === "failure-loop");
  const visibleEvidence = evidence.filter((item) => {
    if (item.signal === "unfinished" || item.signal === "time-gap" || absoluteStopEvidence.includes(item)) return true;
    const value = metricForSignal[item.signal];
    if (!isAbnormal(value, fallbackForSignal[item.signal])) return false;
    item.metric = value; item.title = `${item.title} — ${relativeMetric(value)}`;
    item.detail = l10n.t("{0} Value this time: {1}", item.detail, absoluteMetric(value));
    return true;
  });
  const addMetricEvidence = (signal: "token-skew" | "output-tokens", label: string, value: AnalysisMetric) => {
    if (!isAbnormal(value, false) || visibleEvidence.some((item) => item.signal === signal)) return;
    visibleEvidence.push({ id: `e${evidence.length + visibleEvidence.length + 1}`, signal, title: `${label} — ${relativeMetric(value)}`, detail: l10n.t("Value for the whole session: {0}", absoluteMetric(value)), metric: value });
  };
  addMetricEvidence("token-skew", l10n.t("Subagent ratio"), metrics.agentTokenRatio);
  addMetricEvidence("output-tokens", l10n.t("Output tokens"), metrics.outputTokens);
  evidence.splice(0, evidence.length, ...visibleEvidence);
  const stop = absoluteStopEvidence.length > 0;
  const review = evidence.length > 0;
  const status: ConclusionStatus = stop ? "stop" : review ? "review" : "complete";
  const appliedRule = stop
    ? l10n.t("Stop recommended: three consecutive failures in the same turn, three consecutive failures with the same error signature, or five or more with the same signature.")
    : review
      ? l10n.t("Review required: relative-metric or absolute-fallback signals are present.")
      : l10n.t("Completed: no decision signals.");
  const baselineNotice = baseline
    ? l10n.t("Multiples are compared only when both the exposure cohort and the non-zero sample are n>=5 for a metric.")
    : l10n.t("No baseline, so absolute thresholds are used.");
  const conclusion: AnalysisConclusion = {
    status,
    appliedRule: `${appliedRule} ${baselineNotice}`,
    criteria: [
      l10n.t("Stop recommended: three consecutive failures in the same turn or with the same error signature, or five or more with the same error signature."),
      l10n.t("Review required: a continuous metric is at least 2x the personal baseline median."),
      l10n.t("Sparse metrics: the exposure-session rate is shown per metric; occurrence below 10% is weak evidence, and at 10% or above a median ratio of 2x or more when it occurs is the evidence."),
      l10n.t("If a metric's exposure cohort or non-zero sample n is below 5, that metric alone falls back to absolute thresholds."),
      l10n.t("Completed: none of the above, and a normal termination."),
    ],
    evidence,
    actions: evidence.length ? evidence.map((item) => ({ evidenceId: item.id, text: actionFor(item.signal) })) : [{ text: l10n.t("Resume this session only if necessary.") }],
  };
  const sortedTs = [...timestamps].sort((a, b) => a - b);
  const totalElapsedMs = startedAt !== null && endedAt !== null ? endedAt - startedAt : 0;
  const idleGaps = sortedTs
    .slice(1)
    .map((endMs, index) => ({ startMs: sortedTs[index], endMs, durMs: endMs - sortedTs[index] }))
    .filter((gap) => gap.durMs > IDLE_GAP_MS)
    .sort((a, b) => b.durMs - a.durMs);
  const idleMs = idleGaps.reduce((sum, gap) => sum + gap.durMs, 0);
  const activeMs = Math.max(0, totalElapsedMs - idleMs);
  const byElapsed = (a: { elapsedMs: number }, b: { elapsedMs: number }) => b.elapsedMs - a.elapsedMs;
  return {
    title: title || l10n.t("(Untitled session)"),
    startedAt,
    endedAt,
    totalElapsedMs,
    idleGapCount: idleGaps.length,
    idleMs,
    activeMs,
    idleGaps: idleGaps.slice(0, 5),
    toolCalls: order.length,
    toolFails,
    outputTokens,
    agentCount,
    agentTokens,
    agentTokensUnmeasured:
      agentCount === 0 || agentTokensMeasuredCount === agentCount
        ? null
        : agentTokensMeasuredCount === 0
          ? "all"
          : "partial",
    agentTokensNote:
      agentCount === 0 || agentTokensMeasuredCount === agentCount
        ? null
        : agentTokensMeasuredCount === 0
          ? l10n.t("Tokens not measured")
          : l10n.t("{0} calls have unmeasured tokens", agentCount - agentTokensMeasuredCount),
    model,
    turns,
    averageTurnDurationMs,
    failureLoopCount,
    baseline,
    baselineMode,
    baselineNote: baselineScanNote(baselineMode, baselineScan),
    coverage: {
      malformedLines,
      note:
        malformedLines > 0
          ? l10n.t("⚠ {0} lines of the record could not be read. This verdict covers only the readable part; failures in the missing lines were not counted.", malformedLines)
          : null,
    },
    conclusion,
    findings,
    tools: [...tools.values()].sort(byElapsed),
    skills: [...skills.values()].sort(byElapsed),
  };
}
