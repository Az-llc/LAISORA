import fs from "node:fs";
import path from "node:path";
import { claudeConfigDir } from "./claude-env";
import { IMPROVEMENT_INDEX_FILE, IMPROVEMENT_PATTERNS_FILE } from "./improvement-brief";
import { patternsJson, renderIndex, scanTranscripts } from "./improvement-scan";
import { RECORD_FIELD_MAX, extractRecords, parseRecordLocation, resolveRecordFiles } from "./improvement-record";

export interface ImprovementScanSummary {
  readonly indexBytes: number;
  readonly patterns: number;
  readonly hookGroups: number;
  readonly conversations: number;
  readonly runtimeSec: number;
  readonly selfCheck: { filesChecked: number; mismatchFiles: number; rawNonForkErrors: number; creditedNonFork: number; creditedFromForkCopyWithoutOrigin: number };
}

export type ImprovementScanMessage =
  | { readonly type: "done"; readonly summary: ImprovementScanSummary; readonly mismatches: readonly unknown[] }
  | { readonly type: "failed"; readonly error: string };

function option(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1] !== undefined) out.push(args[++i]);
  return out;
}

const configDirOf = (args: string[]): string => option(args, "--config-dir")[0] ?? claudeConfigDir();

async function scan(args: string[]): Promise<ImprovementScanMessage> {
  const configDir = configDirOf(args);
  const out = option(args, "--out")[0];
  if (!out) throw new Error("--out is required");
  const projectsDir = path.join(configDir, "projects");
  const result = await scanTranscripts({ projectsDir, configDir, laisoraSources: option(args, "--laisora-source") });
  const ctx = { generatedAt: new Date().toISOString(), projectsDir };
  const index = renderIndex(result, ctx);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, IMPROVEMENT_PATTERNS_FILE), patternsJson(result, ctx));
  fs.writeFileSync(path.join(out, IMPROVEMENT_INDEX_FILE), index);
  const { mismatches, ...selfCheck } = result.selfCheck;
  return {
    type: "done",
    summary: { indexBytes: Buffer.byteLength(index), patterns: result.patterns.length, hookGroups: result.hookGroups.length, conversations: result.stats.parentFiles, runtimeSec: result.stats.runtimeSec, selfCheck },
    mismatches,
  };
}

async function record(args: string[]): Promise<string> {
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  const loc = parseRecordLocation(positional[0] ?? "", positional[1]);
  if (!loc) throw new Error("usage: record <prefix>:<parent|agent-…>:<line> | <file.jsonl>:<line> | <file.jsonl> <line> [--around N] [--max CHARS]");
  const files = resolveRecordFiles(path.join(configDirOf(args), "projects"), loc);
  if (!files.length) throw new Error(`no transcript file matches ${positional[0]}`);
  const around = Number(option(args, "--around")[0] ?? 0) || 0;
  const max = Number(option(args, "--max")[0] ?? RECORD_FIELD_MAX) || RECORD_FIELD_MAX;
  const parts: string[] = [];
  if (files.length > 1) parts.push(`(${files.length} files match; showing each)`);
  for (const f of files.slice(0, 3)) parts.push(await extractRecords(f, loc.line, around, max));
  return parts.join("\n\n");
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "scan") {
    if (process.send) process.once("disconnect", () => process.exit(typeof process.exitCode === "number" ? process.exitCode : 1));
    let message: ImprovementScanMessage;
    try { message = await scan(args); } catch (e) { message = { type: "failed", error: e instanceof Error ? e.stack ?? e.message : String(e) }; }
    if (process.send) await new Promise<void>((resolve) => process.send!(message, () => resolve()));
    else process.stdout.write(JSON.stringify(message, null, 2) + "\n");
    process.exitCode = message.type === "done" ? 0 : 1;
    if (process.send) process.disconnect?.();
    return;
  }
  if (command === "record") {
    try { process.stdout.write((await record(args)) + "\n"); } catch (e) { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; }
    return;
  }
  process.stderr.write("usage: improvement.mjs scan --out <dir> [--config-dir <dir>] [--laisora-source <file>]... | record <location> [--around N] [--max CHARS]\n");
  process.exitCode = 2;
}

void main();
