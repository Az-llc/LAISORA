export type CacheTtl = "5m" | "1h";
export const PROMPT_CACHE_WRITE_MULTIPLIER: Readonly<Record<CacheTtl, number>> = { "5m": 1.25, "1h": 2 };
export const PROMPT_CACHE_PRICES_CHECKED_ON = "2026-10-12";
export type TokenPrices = { readonly input: number; readonly read: number; readonly output: number };
export type ClaudeModelPrices = TokenPrices & { readonly overLongPrompt?: TokenPrices & { readonly aboveTokens: number } };
export const CLAUDE_MODEL_PRICES: Readonly<Record<string, ClaudeModelPrices>> = {
  "Haiku 5.5": { input: 0.1, read: 0.01, output: 0.5, overLongPrompt: { aboveTokens: 100_000, input: 0.5, read: 0.05, output: 2.5 } },
  "Sonnet 5.5": { input: 2, read: 0.1, output: 10 },
  "Opus 5.5": { input: 4, read: 0.2, output: 20 },
  "Fable 5.1": { input: 10, read: 0.25, output: 50 },
};
