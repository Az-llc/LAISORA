export const CONFIG_FILE_INVALID = "config_file_invalid";

export interface InvalidConfigFile {
  path: string;
  isGlobal: boolean;
  backupSearched: boolean;
  backupPath?: string;
}

export const CONFIG_BACKUP_STATES = ["found", "none", "unknown"] as const;
export type ConfigBackupState = (typeof CONFIG_BACKUP_STATES)[number];

export interface InvalidConfigShown {
  path: string;
  backup: ConfigBackupState;
  backupPath?: string;
}

export const INVALID_CONFIG_OPEN_TARGETS = ["file", "backup"] as const;
export type InvalidConfigOpenTarget = (typeof INVALID_CONFIG_OPEN_TARGETS)[number];

export interface InvalidConfigEventRef {
  generation: number;
  seq: number;
}

function isFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

export function invalidConfigFileOf(record: Record<string, unknown>): InvalidConfigFile | undefined {
  if (record.type !== "result" || record.startup_failure_reason !== CONFIG_FILE_INVALID) return undefined;
  const file = record.invalid_config_file;
  if (typeof file !== "object" || file === null || Array.isArray(file)) return undefined;
  const { path, is_global: isGlobal, backup_searched: backupSearched, backup_path: backupPath } = file as Record<string, unknown>;
  if (!isFilePath(path) || typeof isGlobal !== "boolean" || typeof backupSearched !== "boolean") return undefined;
  if (backupPath !== undefined && !isFilePath(backupPath)) return undefined;
  return { path, isGlobal, backupSearched, ...(backupPath === undefined ? {} : { backupPath }) };
}

export function configBackupState(file: Pick<InvalidConfigFile, "isGlobal" | "backupSearched" | "backupPath">): ConfigBackupState {
  if (file.backupPath !== undefined) return "found";
  return file.backupSearched || !file.isGlobal ? "none" : "unknown";
}

export function shownInvalidConfig(file: InvalidConfigFile): InvalidConfigShown {
  const backup = configBackupState(file);
  return { path: file.path, backup, ...(backup === "found" ? { backupPath: file.backupPath } : {}) };
}

export function isInvalidConfigShown(value: Record<string, unknown>): boolean {
  if (!isFilePath(value.path) || !(CONFIG_BACKUP_STATES as readonly unknown[]).includes(value.backup)) return false;
  return value.backup === "found" ? isFilePath(value.backupPath) : value.backupPath === undefined;
}

export function sameInvalidConfig(a: InvalidConfigShown, b: InvalidConfigShown): boolean {
  return a.path === b.path && a.backup === b.backup && a.backupPath === b.backupPath;
}

export function invalidConfigNoticeShown(previous: InvalidConfigShown | undefined, next: InvalidConfigShown, userSend: boolean): boolean {
  return userSend || previous === undefined || !sameInvalidConfig(previous, next);
}

export function isInvalidConfigEventRef(generation: unknown, seq: unknown): boolean {
  return Number.isSafeInteger(generation) && Number.isSafeInteger(seq);
}

export function invalidConfigOpenPath(
  events: readonly ({ kind: string; generation: number; seq: number } & Partial<InvalidConfigShown>)[],
  ref: InvalidConfigEventRef,
  target: InvalidConfigOpenTarget
): string | undefined {
  const shown = events.find((ev) => ev.kind === CONFIG_FILE_INVALID && ev.generation === ref.generation && ev.seq === ref.seq);
  return target === "backup" ? shown?.backupPath : shown?.path;
}
