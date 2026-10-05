import { unlink } from "node:fs/promises";
import { join } from "node:path";

export async function deleteOldLearningStore(globalStorage: string, log: (line: string) => void): Promise<void> {
  try {
    await unlink(join(globalStorage, "laisora-learning", "records.jsonl"));
  } catch {
    return;
  }
  log("[learning] Deleted old learning store records.jsonl.");
}
