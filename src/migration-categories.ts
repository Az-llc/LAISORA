import * as l10n from "@vscode/l10n";

export const MIGRATION_CATEGORIES = ["todo", "laisoraSettings", "claudeEnv", "conversations", "memory"] as const;
export type MigrationCategory = typeof MIGRATION_CATEGORIES[number];
export const isMigrationCategory = (value: unknown): value is MigrationCategory => (MIGRATION_CATEGORIES as readonly unknown[]).includes(value);

export function migrationCategoryTitle(category: MigrationCategory): string {
  switch (category) {
    case "todo": return "ToDo";
    case "laisoraSettings": return l10n.t("LAISORA settings");
    case "claudeEnv": return l10n.t("Claude environment");
    case "conversations": return l10n.t("Conversation records");
    case "memory": return l10n.t("Memory");
  }
}

export const MIGRATION_OPERATIONS = ["export", "import"] as const;
export type MigrationOperation = typeof MIGRATION_OPERATIONS[number];
export const MIGRATION_PROGRESS_PHASES = ["preparing", "archiving", "extracting", "placing"] as const;
export type MigrationProgressPhase = typeof MIGRATION_PROGRESS_PHASES[number];

export interface MigrationProgress {
  readonly operation: MigrationOperation;
  readonly phase: MigrationProgressPhase;
  readonly startedAt: number;
  readonly done?: number;
  readonly total?: number;
}

export interface MigrationProgressView {
  readonly stage: MigrationProgressPhase | "finishing";
  readonly percent?: number;
  readonly done?: number;
  readonly total?: number;
  readonly elapsedMs: number;
}

export function migrationProgressView(progress: MigrationProgress, now: number): MigrationProgressView {
  const elapsedMs = Math.max(0, now - progress.startedAt);
  const { phase, done, total } = progress;
  const counted = { ...(done !== undefined ? { done } : {}), ...(total !== undefined ? { total } : {}) };
  if (phase !== "archiving" || done === undefined || total === undefined || total <= 0) return { stage: phase, ...counted, elapsedMs };
  if (done >= total) return { stage: "finishing", elapsedMs };
  return { stage: phase, percent: Math.min(99, Math.floor(done * 100 / total)), ...counted, elapsedMs };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60, rest = seconds % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`;
}

export function isProjectDirName(name: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(name);
}

export function formatBytes(bytes: number, locale?: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toLocaleString(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}
