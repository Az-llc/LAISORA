import { configurationBound } from "./configuration-defaults";

export const TRANSCRIPT_RETENTION_DAYS_KEY = "claude.transcriptRetentionDays";
export const TRANSCRIPT_RETENTION_DAYS_MIN = configurationBound(TRANSCRIPT_RETENTION_DAYS_KEY, "minimum")!;
export const CLAUDE_CODE_DEFAULT_CLEANUP_PERIOD_DAYS = 30;

export type TranscriptRetentionSettings = { cleanupPeriodDays: number } | undefined;
export type TranscriptRetentionFallback = { source: "noUserSource" } | { source: "userSettings" | "claudeDefault"; days: number };

export function isTranscriptRetentionDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= TRANSCRIPT_RETENTION_DAYS_MIN;
}

export function transcriptRetentionFallback(settingSources: readonly string[], userSettingsCleanupPeriodDays: unknown): TranscriptRetentionFallback {
  if (!settingSources.includes("user")) return { source: "noUserSource" };
  if (isTranscriptRetentionDays(userSettingsCleanupPeriodDays)) return { source: "userSettings", days: userSettingsCleanupPeriodDays };
  return { source: "claudeDefault", days: CLAUDE_CODE_DEFAULT_CLEANUP_PERIOD_DAYS };
}

export function isTranscriptRetentionFallback(value: unknown): value is TranscriptRetentionFallback {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.source === "noUserSource") return Object.keys(v).length === 1;
  return (v.source === "userSettings" || v.source === "claudeDefault") && isTranscriptRetentionDays(v.days) && Object.keys(v).length === 2;
}

export function configuredTranscriptRetentionDays(get: (key: typeof TRANSCRIPT_RETENTION_DAYS_KEY) => unknown): number | null {
  const value = get(TRANSCRIPT_RETENTION_DAYS_KEY);
  return isTranscriptRetentionDays(value) ? value : null;
}

export function transcriptRetentionSettings(get: (key: typeof TRANSCRIPT_RETENTION_DAYS_KEY) => unknown): TranscriptRetentionSettings {
  const days = configuredTranscriptRetentionDays(get);
  return days === null ? undefined : { cleanupPeriodDays: days };
}
