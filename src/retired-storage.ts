import { lstat, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const RETIRED_LEARNING_DIRECTORY = "laisora-learning";
export const RETIRED_BASELINE_CACHE_KEY = "laisora.analysis.personalBaseline.v1";

interface RetiredKeyStore {
  get(key: string): unknown;
  update(key: string, value: undefined): Thenable<void>;
}

function errorCodeSuffix(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
}

export async function removeRetiredBaselineCache(globalState: RetiredKeyStore | undefined, log: (line: string) => void): Promise<void> {
  if (globalState?.get(RETIRED_BASELINE_CACHE_KEY) === undefined) return;
  try {
    await globalState.update(RETIRED_BASELINE_CACHE_KEY, undefined);
    log("[startup] removed the retired baseline cache");
  } catch (error) {
    log(`[startup] could not remove the retired baseline cache${errorCodeSuffix(error)}`);
  }
}

export async function removeRetiredLearningStore(globalStorage: string | undefined, log: (line: string) => void): Promise<void> {
  if (!globalStorage) return;
  const root = resolve(globalStorage);
  const target = resolve(join(root, RETIRED_LEARNING_DIRECTORY));
  if (dirname(target) !== root || basename(target) !== RETIRED_LEARNING_DIRECTORY) return;
  try {
    const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!entry) return;
    await rm(target, { recursive: entry.isDirectory() && !entry.isSymbolicLink(), force: true });
    log("[startup] removed the retired learning store");
  } catch (error) {
    log(`[startup] could not remove the retired learning store${errorCodeSuffix(error)}`);
  }
}
