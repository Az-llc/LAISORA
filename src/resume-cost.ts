export interface UsageTurn {
  at: string;
  gapMs: number;
  contextTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  cacheHitRatio: number;
}

export type UsageTurns = UsageTurn[] & { malformedLines: number };
export const DEFAULT_RESUME_THRESHOLDS = Object.freeze({ pauseMs: 60 * 60 * 1000, lowHitRatio: 0.5 });
export type ResumeThresholds = typeof DEFAULT_RESUME_THRESHOLDS;
export type TurnKind = "resume-cold" | "resume-warm" | "cold" | "warm";

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseUsageTurns(lines: Iterable<string>): UsageTurns {
  const turns: UsageTurns = Object.assign([], { malformedLines: 0 });
  let previous: number | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      turns.malformedLines++;
      continue;
    }
    if (!recordValue(record)) {
      turns.malformedLines++;
      continue;
    }
    if (record.type !== "assistant" || !recordValue(record.message) || record.message.usage == null) continue;
    const usage = record.message.usage;
    const atMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    // R-ANL-17: invalid usage must be counted instead of becoming a zero-cost turn.
    if (!recordValue(usage) || !Number.isFinite(atMs) ||
        !["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]
          .every(key => usage[key] === undefined || (typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0))) {
      turns.malformedLines++;
      continue;
    }
    const uncachedInputTokens = (usage.input_tokens as number | undefined) ?? 0;
    const cacheCreationTokens = (usage.cache_creation_input_tokens as number | undefined) ?? 0;
    const cacheReadTokens = (usage.cache_read_input_tokens as number | undefined) ?? 0;
    const outputTokens = (usage.output_tokens as number | undefined) ?? 0;
    const contextTokens = uncachedInputTokens + cacheCreationTokens + cacheReadTokens;
    turns.push({
      at: new Date(atMs).toISOString(), gapMs: previous === undefined ? 0 : atMs - previous,
      contextTokens, cacheReadTokens, cacheCreationTokens, uncachedInputTokens, outputTokens,
      cacheHitRatio: contextTokens === 0 ? 0 : cacheReadTokens / contextTokens,
    });
    previous = atMs;
  }
  return turns;
}

export function classifyTurn(turn: UsageTurn, thresholds: ResumeThresholds = DEFAULT_RESUME_THRESHOLDS): TurnKind {
  const resume = turn.gapMs >= thresholds.pauseMs;
  const cold = turn.cacheHitRatio < thresholds.lowHitRatio;
  return resume ? (cold ? "resume-cold" : "resume-warm") : (cold ? "cold" : "warm");
}

export function summarizeResumeCost(turns: readonly UsageTurn[], thresholds: ResumeThresholds = DEFAULT_RESUME_THRESHOLDS) {
  let resumes = 0;
  let resumeCold = 0;
  let uncachedTokensOnResumeCold = 0;
  let uncachedTokensTotal = 0;
  let largestContext = 0;
  const table: Array<Pick<UsageTurn, "at" | "gapMs" | "contextTokens" | "cacheHitRatio"> & { kind: TurnKind }> = [];
  for (const turn of turns) {
    const kind = classifyTurn(turn, thresholds);
    const uncached = turn.uncachedInputTokens + turn.cacheCreationTokens;
    uncachedTokensTotal += uncached;
    largestContext = Math.max(largestContext, turn.contextTokens);
    if (kind === "resume-cold" || kind === "resume-warm") resumes++;
    if (kind === "resume-cold") {
      resumeCold++;
      uncachedTokensOnResumeCold += uncached;
    }
    if (kind !== "warm") {
      table.push({ at: turn.at, gapMs: turn.gapMs, contextTokens: turn.contextTokens, cacheHitRatio: turn.cacheHitRatio, kind });
    }
  }
  return { turns: turns.length, resumes, resumeCold, uncachedTokensOnResumeCold, uncachedTokensTotal, largestContext, table: table.slice(-200) };
}
