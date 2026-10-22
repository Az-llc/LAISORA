import { CLAUDE_MODEL_PRICES, PROMPT_CACHE_WRITE_MULTIPLIER, type CacheTtl, type ClaudeModelPrices } from "./claude-prices";
import { shortModelDisplayName } from "./model-display-name";
import type { AssistantUsage } from "./protocol";

export const CACHE_HIT_TERM = "cache hit";
export const CACHE_TTL_MS: Readonly<Record<CacheTtl, number>> = { "5m": 5 * 60_000, "1h": 60 * 60_000 };

export interface CacheTtlRequest { readonly at: number; readonly usage: AssistantUsage }
export interface CacheTtlScenario { costUsd: number; readTokens: number; contextTokens: number }
export type RunCacheTtlCost = Record<CacheTtl, CacheTtlScenario>;

export function claudeModelPrices(model: string | null): ClaudeModelPrices | undefined {
  return model === null ? undefined : CLAUDE_MODEL_PRICES[shortModelDisplayName(model)];
}

const otherTtl = (ttl: CacheTtl): CacheTtl => ttl === "5m" ? "1h" : "5m";

export function cacheWriteTtl(usages: readonly Pick<AssistantUsage, "cacheCreation5mInputTokens" | "cacheCreation1hInputTokens">[]): CacheTtl | null {
  let written5m = 0, written1h = 0;
  for (const usage of usages) {
    if (usage.cacheCreation5mInputTokens === undefined || usage.cacheCreation1hInputTokens === undefined) return null;
    written5m += usage.cacheCreation5mInputTokens;
    written1h += usage.cacheCreation1hInputTokens;
  }
  if ((written5m > 0) === (written1h > 0)) return null;
  return written1h > 0 ? "1h" : "5m";
}

export function runCacheTtlCost(requests: readonly CacheTtlRequest[], prices: ClaudeModelPrices | undefined): RunCacheTtlCost | null {
  if (prices === undefined || requests.length === 0) return null;
  const ordered = [...requests].sort((a, b) => a.at - b.at);
  if (ordered.some(({ usage }) => usage.inputTokens === undefined || usage.cacheCreationInputTokens === undefined
    || usage.cacheReadInputTokens === undefined || usage.outputTokens === undefined)) return null;
  const actual = cacheWriteTtl(ordered.map(({ usage }) => usage));
  if (actual === null) return null;
  const result = { "5m": { costUsd: 0, readTokens: 0, contextTokens: 0 }, "1h": { costUsd: 0, readTokens: 0, contextTokens: 0 } };
  let previousPrefix = 0;
  ordered.forEach(({ at, usage }, index) => {
    const input = usage.inputTokens!, written = usage.cacheCreationInputTokens!, read = usage.cacheReadInputTokens!, output = usage.outputTokens!;
    const prefix = read + written;
    const gap = index === 0 ? 0 : at - ordered[index - 1].at;
    const between = gap > CACHE_TTL_MS["5m"] && gap <= CACHE_TTL_MS["1h"];
    const tier = prices.overLongPrompt && input + prefix > prices.overLongPrompt.aboveTokens ? prices.overLongPrompt : prices;
    for (const ttl of [actual, otherTtl(actual)]) {
      const replayedRead = ttl === actual || !between ? read : ttl === "5m" ? 0 : prefix < previousPrefix ? read : Math.min(prefix, Math.max(read, previousPrefix));
      const replayedWrite = prefix - replayedRead;
      const scenario = result[ttl];
      scenario.costUsd += (input * tier.input + replayedWrite * tier.input * PROMPT_CACHE_WRITE_MULTIPLIER[ttl] + replayedRead * tier.read + output * tier.output) / 1_000_000;
      scenario.readTokens += replayedRead;
      scenario.contextTokens += input + prefix;
    }
    previousPrefix = prefix;
  });
  return result;
}

export interface RoleCacheTtlOption { ttl: CacheTtl; label: string; setting: boolean; cheaper: boolean; costLabel: string; hitPercent: number | null }
export interface RoleCacheTtlView { claudeRunCount: number; partial: boolean; options: RoleCacheTtlOption[] }

const ROLE_CACHE_TTL_ORDER: readonly CacheTtl[] = ["1h", "5m"];

export function roleCacheTtl(runs: readonly (RunCacheTtlCost | null)[], setting: CacheTtl): RoleCacheTtlView | undefined {
  const measured = runs.filter((run): run is RunCacheTtlCost => run !== null);
  if (measured.length === 0) return undefined;
  const sum = (ttl: CacheTtl, field: keyof CacheTtlScenario): number => measured.reduce((total, run) => total + run[ttl][field], 0);
  const cents = (ttl: CacheTtl): number => Math.round(sum(ttl, "costUsd") * 100);
  return {
    claudeRunCount: measured.length,
    partial: measured.length < runs.length,
    options: ROLE_CACHE_TTL_ORDER.map((ttl) => {
      const context = sum(ttl, "contextTokens");
      return { ttl, label: `${ttl} ${CACHE_HIT_TERM}`, setting: ttl === setting, cheaper: cents(ttl) < cents(otherTtl(ttl)), costLabel: `$${(cents(ttl) / 100).toFixed(2)}`,
        hitPercent: context > 0 ? Math.round(sum(ttl, "readTokens") / context * 100) : null };
    }),
  };
}
