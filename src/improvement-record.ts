import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { IMPROVEMENT_LINE_MAX_CHARS, sanitizeText, textOf } from "./improvement-scan";

export const RECORD_FIELD_MAX = 2000;
export const RECORD_OUTPUT_MAX = 30000;
export const RECORD_AROUND_MAX = 20;

export interface RecordLocation { readonly file?: string; readonly sessionPrefix?: string; readonly part?: string; readonly line: number }

export function parseRecordLocation(arg: string, lineArg?: string): RecordLocation | undefined {
  if (lineArg !== undefined && /^\d+$/.test(lineArg)) return { file: arg, line: Number(lineArg) };
  const short = /^([0-9a-f][0-9a-f-]{3,35}):(parent|agent-[\w-]+?)(?:\.jsonl)?:(\d+)$/i.exec(arg);
  if (short) return { sessionPrefix: short[1].toLowerCase(), part: short[2], line: Number(short[3]) };
  const full = /^(.+\.jsonl):(\d+)$/.exec(arg);
  if (full) return { file: full[1], line: Number(full[2]) };
  return undefined;
}

export function resolveRecordFiles(projectsDir: string, loc: RecordLocation): string[] {
  if (loc.file) return [loc.file];
  const hits: string[] = [];
  let projects: string[] = [];
  try { projects = fs.readdirSync(projectsDir); } catch { return []; }
  for (const project of projects) {
    const pdir = path.join(projectsDir, project);
    let names: string[] = [];
    try { names = fs.readdirSync(pdir); } catch { continue; }
    for (const name of names) {
      if (!name.toLowerCase().startsWith(loc.sessionPrefix!)) continue;
      if (loc.part === "parent" && name.endsWith(".jsonl")) hits.push(path.join(pdir, name));
      if (loc.part !== "parent" && !name.endsWith(".jsonl")) {
        const f = path.join(pdir, name, "subagents", `${loc.part}.jsonl`);
        if (fs.existsSync(f)) hits.push(f);
      }
    }
  }
  return hits;
}

const cap = (s: string, max: number): string => {
  const clean = sanitizeText(s);
  return clean.length <= max ? clean : `${clean.slice(0, max)} … (${clean.length - max} more chars)`;
};

const indent = (s: string): string => s.split("\n").map((l) => `    ${l}`).join("\n");

export interface ToolCallRef { readonly line: number; readonly name: string; readonly input: string }

export function renderRecord(rec: Record<string, any>, lineNo: number, calls: ReadonlyMap<string, ToolCallRef>, max = RECORD_FIELD_MAX): string {
  const head = `[${lineNo}] ${typeof rec.timestamp === "string" ? rec.timestamp : "-"} ${String(rec.type ?? "?")}${rec.isMeta ? " (meta)" : ""}${rec.isSidechain ? " (sidechain)" : ""}`;
  const out = [head];
  const content = rec.message?.content;
  if (typeof content === "string") out.push(`  text:\n${indent(cap(content, max))}`);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === "text" && typeof b.text === "string") out.push(`  text:\n${indent(cap(b.text, max))}`);
      else if (b?.type === "tool_use") out.push(`  tool_use ${String(b.name)} ${String(b.id)}:\n${indent(cap(JSON.stringify(b.input ?? {}, null, 1), max))}`);
      else if (b?.type === "tool_result") {
        const call = calls.get(b.tool_use_id);
        const callNote = call ? `${call.name}, call at line ${call.line}` : "call not found above";
        out.push(`  tool_result ${String(b.tool_use_id)} (${callNote}) is_error=${b.is_error === true}:\n${indent(cap(textOf(b.content), max * 2))}`);
      } else if (b?.type === "thinking") out.push("  thinking: (omitted)");
      else if (b?.type === "image") out.push("  image: (omitted)");
    }
  } else if (rec.type === "attachment" || rec.attachment) out.push(`  attachment:\n${indent(cap(JSON.stringify(rec.attachment ?? {}, null, 1), max))}`);
  else if (typeof rec.content === "string") out.push(`  content:\n${indent(cap(rec.content, max))}`);
  if (rec.toolUseResult && typeof rec.toolUseResult === "object" && Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
    const tur = rec.toolUseResult as Record<string, unknown>;
    const brief = Object.fromEntries(Object.entries(tur).filter(([, v]) => typeof v !== "object" || v === null).map(([k, v]) => [k, typeof v === "string" ? cap(v, 300) : v]));
    if (Object.keys(brief).length) out.push(`  toolUseResult: ${JSON.stringify(brief)}`);
  }
  return out.join("\n");
}

function actorOf(file: string): string {
  const parts = file.split(/[\\/]/);
  const i = parts.lastIndexOf("subagents");
  if (i < 0) return "main conversation";
  let meta = "";
  try {
    const m = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    meta = [m.agentType, m.description].filter((x) => typeof x === "string" && x).join(": ");
  } catch { /* no meta */ }
  return `subagent ${parts[parts.length - 1].replace(/\.jsonl$/, "")}${meta ? ` (${cap(meta, 200)})` : ""}`;
}

export interface CollectedRecord { readonly line: number; readonly rec?: Record<string, any>; readonly state: "record" | "empty" | "oversized" | "unparsable" }
export interface CollectedRecords { readonly from: number; readonly to: number; readonly lines: number; readonly records: readonly CollectedRecord[]; readonly calls: ReadonlyMap<string, ToolCallRef> }

export async function collectRecords(file: string, line: number, around = 0): Promise<CollectedRecords> {
  const span = Math.max(0, Math.min(RECORD_AROUND_MAX, around));
  const from = Math.max(1, line - span);
  const to = line + span;
  const calls = new Map<string, ToolCallRef>();
  const records: CollectedRecord[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const raw of rl) {
      lineNo++;
      if (lineNo > to) break;
      const inWindow = lineNo >= from;
      if (raw.length > IMPROVEMENT_LINE_MAX_CHARS) { if (inWindow) records.push({ line: lineNo, state: "oversized" }); continue; }
      if (!inWindow && !raw.includes('"tool_use"')) continue;
      if (!raw.trim()) { records.push({ line: lineNo, state: "empty" }); continue; }
      let rec: Record<string, any> | undefined;
      try { rec = JSON.parse(raw); } catch { rec = undefined; }
      if (rec?.type === "assistant" && Array.isArray(rec.message?.content)) {
        for (const b of rec.message.content) if (b?.type === "tool_use") calls.set(b.id, { line: lineNo, name: String(b.name), input: JSON.stringify(b.input ?? {}) });
      }
      if (inWindow) records.push(rec && typeof rec === "object" ? { line: lineNo, rec, state: "record" } : { line: lineNo, state: "unparsable" });
    }
  } finally {
    rl.close();
  }
  return { from, to: Math.min(to, lineNo), lines: lineNo, records, calls };
}

export async function extractRecords(file: string, line: number, around = 0, max = RECORD_FIELD_MAX): Promise<string> {
  const c = await collectRecords(file, line, around);
  const out = [`== ${file} · ${actorOf(file)} · lines ${c.from}..${c.to} ==`];
  const shownCalls = new Set<string>();
  for (const r of c.records) {
    if (r.state === "empty" || r.state === "oversized") { out.push(`[${r.line}] (${r.state} line)`); continue; }
    if (r.state === "unparsable" || !r.rec) { out.push(`[${r.line}] (unparsable line, possibly the partial last line)`); continue; }
    const content = r.rec.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        const call = b?.type === "tool_result" ? c.calls.get(b.tool_use_id) : undefined;
        if (call && call.line < c.from && !shownCalls.has(b.tool_use_id)) {
          shownCalls.add(b.tool_use_id);
          out.push(`[${call.line}] matching call ${call.name}:\n${indent(cap(call.input, max))}`);
        }
      }
    }
    out.push(renderRecord(r.rec, r.line, c.calls, max));
  }
  if (c.lines < line) out.push(`(file has only ${c.lines} lines)`);
  const text = out.join("\n");
  return text.length <= RECORD_OUTPUT_MAX ? text : `${text.slice(0, RECORD_OUTPUT_MAX)}\n… (output capped; use a smaller --around)`;
}
