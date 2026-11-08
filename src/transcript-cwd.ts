import { open } from "node:fs/promises";
import { splitCompleteLines } from "./session-display-title";

export const RESUME_CWD_SCAN_BYTES = 64 * 1024;

export async function readCwdWindowLines(filePath: string): Promise<Array<{ text: string; byteOffset: number }>> {
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    const headLength = Math.min(size, RESUME_CWD_SCAN_BYTES);
    const head = new Uint8Array(headLength);
    if (headLength > 0) await handle.read(head, 0, headLength, 0);
    const tailStart = Math.max(headLength, size - RESUME_CWD_SCAN_BYTES);
    const tailLength = size - tailStart;
    const tail = new Uint8Array(tailLength);
    if (tailLength > 0) await handle.read(tail, 0, tailLength, tailStart);
    return [
      ...splitCompleteLines(head, 0).lines,
      ...splitCompleteLines(tail, tailStart).lines,
    ];
  } finally {
    await handle.close();
  }
}

export function lastRelocatedCwd(
  lines: readonly { text: string }[]
): { cwd: string | undefined; malformedLines: number } {
  let cwd: string | undefined;
  let malformedLines = 0;
  for (const line of lines) {
    if (!line.text.includes('"relocated"')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line.text);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const fields = record as { type?: unknown; relocatedCwd?: unknown };
    if (fields.type !== "relocated") continue;
    if (typeof fields.relocatedCwd === "string" && fields.relocatedCwd.length > 0) {
      cwd = fields.relocatedCwd;
    }
  }
  return { cwd, malformedLines };
}
