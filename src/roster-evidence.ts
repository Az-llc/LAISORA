// ROLES の根拠: LAISORA が会話へ注入した役割表と、注入中に起動フックが観測したサブエージェントの agentKey。
// セッションごとに Host の保存域へ残し、再起動・resume 後も実行時の役割で数える（R-ANL-23）。
// 記録するのは agentKey・役割・要求 model / effort・時刻・agent_id だけ。プロンプト・説明文・認証情報は入れない。
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import * as path from "node:path";

export const ROSTER_EVIDENCE_VERSION = 1;
// 超過は古い側から捨てる。捨てた範囲の実行は根拠を失い other に落ちる（推し量らない。R-DSP-01）
export const MAX_ROSTER_INJECTIONS = 64;
export const MAX_AGENT_STARTS = 1000;
export const MAX_INJECTED_AGENTS = 256;

export interface InjectedAgentDefinition {
  agentKey: string;
  role: string;
  model: string;
  effort: string | null;
}

// at はその役割表で会話を起動した時刻。次の記録の at まで有効。agents が空 = 注入していない
export interface RosterInjection {
  at: number;
  agents: InjectedAgentDefinition[];
}

export interface AgentStartObservation {
  agentId: string;
  agentKey: string;
  at: number;
  model?: string;
  effort?: string;
}

export interface RosterEvidence {
  injections: RosterInjection[];
  starts: AgentStartObservation[];
}

export function emptyRosterEvidence(): RosterEvidence {
  return { injections: [], starts: [] };
}

const METADATA_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;
const metadata = (v: unknown): v is string => typeof v === "string" && v.length <= 200 && METADATA_RE.test(v);
const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function decodeAgent(raw: unknown): InjectedAgentDefinition | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  if (!metadata(a.agentKey) || !metadata(a.role) || !metadata(a.model)) return undefined;
  if (a.effort !== null && !metadata(a.effort)) return undefined;
  return { agentKey: a.agentKey, role: a.role, model: a.model, effort: a.effort as string | null };
}

function decodeStart(raw: unknown): AgentStartObservation | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  if (!metadata(s.agentId) || !metadata(s.agentKey) || !time(s.at)) return undefined;
  if (s.model !== undefined && !metadata(s.model)) return undefined;
  if (s.effort !== undefined && !metadata(s.effort)) return undefined;
  return {
    agentId: s.agentId,
    agentKey: s.agentKey,
    at: s.at,
    ...(s.model !== undefined ? { model: s.model as string } : {}),
    ...(s.effort !== undefined ? { effort: s.effort as string } : {}),
  };
}

// 形の合わない項目は捨てる（素通しすると保存域へ任意の文字列が載る）
export function decodeRosterEvidence(raw: unknown): RosterEvidence | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.version !== ROSTER_EVIDENCE_VERSION || !Array.isArray(r.injections) || !Array.isArray(r.starts)) return undefined;
  const injections: RosterInjection[] = [];
  for (const entry of r.injections) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (!time(e.at) || !Array.isArray(e.agents)) continue;
    injections.push({ at: e.at, agents: e.agents.map(decodeAgent).filter((a): a is InjectedAgentDefinition => a !== undefined) });
  }
  const starts = r.starts.map(decodeStart).filter((s): s is AgentStartObservation => s !== undefined);
  return mergeRosterEvidence({ injections, starts }, emptyRosterEvidence());
}

export function injectionOf(
  variants: ReadonlyArray<{ agentKey: string; role: string; model: string; effort?: string }>,
  at: number
): RosterInjection {
  return {
    at,
    agents: variants
      .map((v) => decodeAgent({ agentKey: v.agentKey, role: v.role, model: v.model, effort: v.effort ?? null }))
      .filter((a): a is InjectedAgentDefinition => a !== undefined)
      .slice(0, MAX_INJECTED_AGENTS),
  };
}

const sameAgents = (a: RosterInjection, b: RosterInjection): boolean => JSON.stringify(a.agents) === JSON.stringify(b.agents);

// 和集合。続けて同じ役割表の記録は最初の 1 件に畳む（有効範囲は変わらない）
export function mergeRosterEvidence(a: RosterEvidence, b: RosterEvidence): RosterEvidence {
  const all = [...a.injections, ...b.injections].sort((x, y) => x.at - y.at);
  const injections: RosterInjection[] = [];
  for (const inj of all) {
    const last = injections[injections.length - 1];
    if (last !== undefined && sameAgents(last, inj)) continue;
    injections.push(inj);
  }
  const byId = new Map<string, AgentStartObservation>();
  for (const s of [...a.starts, ...b.starts]) {
    const prev = byId.get(s.agentId);
    if (prev === undefined) {
      byId.set(s.agentId, s);
      continue;
    }
    byId.set(s.agentId, {
      ...prev,
      at: Math.min(prev.at, s.at),
      ...(prev.model === undefined && s.model !== undefined ? { model: s.model } : {}),
      ...(prev.effort === undefined && s.effort !== undefined ? { effort: s.effort } : {}),
    });
  }
  const starts = [...byId.values()].sort((x, y) => x.at - y.at);
  return {
    injections: injections.slice(Math.max(0, injections.length - MAX_ROSTER_INJECTIONS)),
    starts: starts.slice(Math.max(0, starts.length - MAX_AGENT_STARTS)),
  };
}

export function hasInjectedRoster(evidence: RosterEvidence): boolean {
  return evidence.injections.some((i) => i.agents.length > 0);
}

// 実行の開始時点で有効だった役割表に agentKey があるときだけ役割を返す。起動フックの観測があれば
// その agentKey と時刻を使う。どちらも無ければ undefined（other）
export function attributeSubagent(
  evidence: RosterEvidence,
  run: { agentType?: string; transcriptAgentId?: string; startedAt?: number }
): { definition: InjectedAgentDefinition; start: AgentStartObservation | undefined } | undefined {
  const start = run.transcriptAgentId !== undefined ? evidence.starts.find((s) => s.agentId === run.transcriptAgentId) : undefined;
  if (start !== undefined && run.agentType !== undefined && run.agentType !== start.agentKey) return undefined;
  const key = start?.agentKey ?? run.agentType;
  const at = start?.at ?? run.startedAt;
  if (key === undefined || at === undefined) return undefined;
  let inForce: RosterInjection | undefined;
  for (const inj of evidence.injections) {
    if (inj.at <= at) inForce = inj;
    else break;
  }
  const definition = inForce?.agents.find((a) => a.agentKey === key);
  return definition !== undefined ? { definition, start } : undefined;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export function rosterEvidenceFile(directory: string, sessionId: string): string {
  return path.join(directory, `${digest(sessionId)}.json`);
}

// 読めない・壊れた記録は空として扱い、ファイルは残す（次の書き込みで置き換わる）
export function readRosterEvidence(directory: string, sessionId: string, log: (line: string) => void = () => {}): RosterEvidence {
  let text: string;
  try {
    text = readFileSync(rosterEvidenceFile(directory, sessionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log("[roster-evidence] cannot read roster evidence");
    return emptyRosterEvidence();
  }
  try {
    const decoded = decodeRosterEvidence(JSON.parse(text));
    if (decoded === undefined) log("[roster-evidence] unreadable roster evidence: unexpected shape");
    return decoded ?? emptyRosterEvidence();
  } catch {
    log("[roster-evidence] unreadable roster evidence: invalid JSON");
    return emptyRosterEvidence();
  }
}

export async function writeRosterEvidence(directory: string, sessionId: string, evidence: RosterEvidence): Promise<void> {
  await mkdir(directory, { recursive: true });
  const target = rosterEvidenceFile(directory, sessionId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const contents = JSON.stringify({ version: ROSTER_EVIDENCE_VERSION, injections: evidence.injections, starts: evidence.starts });
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
