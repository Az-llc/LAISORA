import { unlink } from "node:fs/promises";
import { join } from "node:path";

export const OLD_LEARNING_FILES = ["records.jsonl", "ledger.jsonl"] as const;

export async function deleteOldLearningStore(globalStorage: string, log: (line: string) => void): Promise<void> {
  for (const name of OLD_LEARNING_FILES) {
    try { await unlink(join(globalStorage, "laisora-learning", name)); }
    catch { continue; }
    log(`[learning] Deleted old learning store ${name}.`);
  }
}
