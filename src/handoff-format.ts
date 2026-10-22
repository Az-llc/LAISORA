const HANDOFF_FACT_LOCALE = "en-US";

export function formatHandoffTokens(tokens: number): string {
  return tokens.toLocaleString(HANDOFF_FACT_LOCALE);
}

export function formatHandoffTime(at: number): string {
  return new Date(at).toLocaleTimeString(HANDOFF_FACT_LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false });
}
