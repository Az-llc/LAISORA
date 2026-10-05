import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { restoreLearningRecord, type LearningRecord } from "./learning";

export interface LearningRead { records: LearningRecord[]; skipped: number; incompleteTail?: boolean; incompleteBatch?: boolean }

function parseLine(line: string | undefined): unknown {
  if (line === undefined) return undefined;
  try { return JSON.parse(line); } catch { return undefined; }
}

function batchHeader(value: unknown): { ids: string[]; valid: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("batch" in value)) return undefined;
  const batch = (value as { batch: unknown }).batch;
  const ids = Array.isArray(batch) ? batch.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  const valid = Object.keys(value).length === 1 && Array.isArray(batch) && batch.length > 1
    && ids.length === batch.length && new Set(ids).size === ids.length;
  return { ids, valid };
}

export async function readLearning(file: string): Promise<LearningRead> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], skipped: 0 };
    throw error;
  }
  const records: LearningRecord[] = [];
  let skipped = 0, incompleteBatch = false;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (let index = 0; index < lines.length; index++) {
    const value = parseLine(lines[index]);
    if (value === undefined) { skipped++; continue; }
    const batch = batchHeader(value);
    if (batch) {
      const wanted = new Set(batch.ids), members: LearningRecord[] = [];
      while (members.length < batch.ids.length) {
        const member = restoreLearningRecord(parseLine(lines[index + 1 + members.length]));
        if (!member || !wanted.has(member.opId)) break;
        members.push(member);
      }
      if (batch.valid && members.length === batch.ids.length && members.every((member, i) => member.opId === batch.ids[i])) records.push(...members);
      else incompleteBatch = true;
      index += members.length;
      continue;
    }
    const record = restoreLearningRecord(value);
    if (record) records.push(record);
    else skipped++;
  }
  return { records, skipped, incompleteTail: text.length > 0 && !text.endsWith("\n"), ...(incompleteBatch ? { incompleteBatch } : {}) };
}

export async function appendLearning(file: string, records: LearningRecord[]): Promise<void> {
  if (!records.length) return;
  await mkdir(dirname(file), { recursive: true });
  const lines = records.length > 1 ? [{ batch: records.map(record => record.opId) }, ...records] : records;
  await appendFile(file, lines.map(line => `${JSON.stringify(line)}\n`).join(""), "utf8");
}
