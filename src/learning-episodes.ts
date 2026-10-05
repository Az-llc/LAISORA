import { privateTextR06, textHash } from "./learning";
import { SIG_VERSION } from "./learning-signature";

export type EpisodeStatus = "counted" | "transient" | "human" | "hook" | "probe" | "unclassified" | "project" | "unknown-project" | "unknown-model" | "state-unavailable";

export type RuleKey =
  | { readonly sig: string; readonly bind: "conductor"; readonly model: string }
  | { readonly sig: string; readonly bind: "target"; readonly executor: string; readonly model: string; readonly effort: string; readonly role: string };

export interface EpisodeRecord {
  readonly kind: "episode";
  readonly v: 2;
  readonly at: string;
  readonly opId: string;
  readonly sig: string;
  readonly sigV: number;
  readonly tool: string;
  readonly cls: string;
  readonly head: string;
  readonly label?: number;
  readonly ruleId: string;
  readonly key: RuleKey;
  readonly conversation: string;
  readonly recipient: string;
  readonly run: string;
  readonly dispatchId: string;
  readonly session: string;
  readonly toolUse: string;
  readonly project: string;
  readonly status: EpisodeStatus;
  readonly labelFacts?: { readonly code?: string; readonly fields?: readonly string[]; readonly schemaV?: number };
}

export type ItemRef = { readonly type: "rule"; readonly ruleId: string } | { readonly type: "claim"; readonly itemId: string };

export interface UseRecord {
  readonly kind: "use";
  readonly v: 2;
  readonly at: string;
  readonly opId: string;
  readonly item: ItemRef;
  readonly conversation: string;
  readonly recipient: string;
  readonly run: string;
  readonly dispatchId: string;
  readonly runs?: readonly string[];
}

export interface DeliveryItem {
  readonly type: "rule" | "claim" | "measured" | "notice";
  readonly id: string;
}

export interface DeliveryRecord {
  readonly kind: "delivery";
  readonly v: 2;
  readonly at: string;
  readonly opId: string;
  readonly conversation: string;
  readonly session: string;
  readonly conductorModel: string;
  readonly project: string;
  readonly items: readonly DeliveryItem[];
  readonly setHash: string;
  readonly chars: number;
  readonly dropped: number;
  readonly outcome: "sent" | "model-mismatch";
  readonly exposureId?: string;
}

export interface ClaimRun { readonly runId: string; readonly endAt: string }

export interface ClaimRecord {
  readonly kind: "claim";
  readonly v: 2;
  readonly at: string;
  readonly opId: string;
  readonly source: "observation" | "public";
  readonly executor: string;
  readonly model: string;
  readonly effort: string;
  readonly role: string;
  readonly text: string;
  readonly hash: string;
  readonly itemId: string;
  readonly evidence: { readonly runs: readonly ClaimRun[]; readonly creditedRunIds: readonly string[] };
  readonly conversation: string;
  readonly requestId: string;
  readonly inputHash: string;
  readonly session: string;
  readonly conductorModel: string;
  readonly project: string;
  readonly research?: string;
  readonly sources?: readonly { readonly url: string; readonly checkedAt: string }[];
  readonly figures?: string;
}

export interface ExposureRecord {
  readonly kind: "exposure";
  readonly v: 2;
  readonly at: string;
  readonly opId: string;
  readonly exposureId: string;
  readonly conversation: string;
  readonly session: string;
  readonly recipient: string;
  readonly run: string;
  readonly dispatchId: string;
  readonly items: readonly DeliveryItem[];
  readonly promptHash: string;
  readonly requestedModel: string;
  readonly requestedEffort: string;
  readonly observedModel: string;
  readonly observedEffort: string;
  readonly attestation?: readonly string[];
  readonly route?: "conductor" | "target";
  readonly executor?: string;
  readonly role?: string;
  readonly reason?: string;
  readonly budget?: { readonly adapter: string; readonly learningAdditionCap: number; readonly learningAdditionPoints: number; readonly commandLineLimit: number; readonly commandLineUnits: number; readonly taskCodePointLimit?: number; readonly taskCodePoints?: number };
  readonly common?: { readonly items: readonly DeliveryItem[]; readonly hash: string; readonly chars: number; readonly compressed?: readonly DeliveryItem[] };
  readonly outcome: "sent" | "withheld" | "budget-withheld" | "disabled" | "state-unavailable" | "model-mismatch" | "dispatch-failed";
}

export interface ResearchCompleteRecord {
  readonly kind: "research-complete";
  readonly v: 2;
  readonly at: string;
  readonly opId: string;
  readonly research: string;
  readonly conversation: string;
  readonly requestId: string;
  readonly inputHash: string;
  readonly items: readonly { readonly itemId: string; readonly hash: string }[];
}

export interface ExperimentAssignmentRecord {
  readonly kind: "experiment-assignment";
  readonly v: 2;
  readonly at: string;
  readonly opId: string;
  readonly conversation: string;
  readonly eligible: boolean;
  readonly reason: string;
  readonly candidates: readonly string[];
  readonly experimentVersion: number;
  readonly detectorVersion: number;
  readonly probability: number;
  readonly arm: "delivery" | "holdout";
  readonly switches: Readonly<Record<string, boolean>>;
}

export interface MeasurementRecord {
  readonly kind: "measurement";
  readonly v: 2;
  readonly at: string;
  readonly opId: string;
  readonly conversation: string;
  readonly run: string;
  readonly counts: Readonly<Record<string, number | null>>;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface LearningControlRecord {
  readonly kind: "switch-change" | "detector-regression";
  readonly v: 2;
  readonly at: string;
  readonly opId: string;
  readonly conversation: string;
  readonly detectorVersion: number;
  readonly rejectedVersion?: number;
  readonly switches: Readonly<Record<string, boolean>>;
}

export interface EpisodeStateRecord {
  readonly kind: "episode-state";
  readonly v: 2;
  readonly at: string;
  readonly opId: string;
  readonly conversation: string;
  readonly recipient: string;
  readonly run: string;
  readonly toolUse: string;
  readonly operation: string;
  readonly action: "failure" | "success";
  readonly sig?: string;
  readonly episode?: EpisodeRecord;
  readonly status?: "state-unavailable";
  readonly tool?: string;
  readonly head?: string;
}

export type LedgerV2Record = EpisodeStateRecord | EpisodeRecord | ClaimRecord | UseRecord | DeliveryRecord | ExposureRecord | ResearchCompleteRecord | ExperimentAssignmentRecord | MeasurementRecord | LearningControlRecord;

function canonicalJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])));
}

export function ruleIdOf(key: RuleKey): string { return textHash(canonicalJson(key)); }
export function episodeOpId(conversation: string, toolUse: string, recipient = "", run = ""): string { return textHash(`episode:${conversation}:${recipient}:${run}:${toolUse}`); }
export function useOpId(itemId: string, conversation: string): string { return textHash(`use:${itemId}:${conversation}`); }
export function itemIdOf(source: ClaimRecord["source"], tags: Pick<ClaimRecord, "executor" | "model" | "effort" | "role">, hash: string): string {
  return textHash(canonicalJson({ source, executor: tags.executor, model: tags.model, effort: tags.effort, role: tags.role, hash }));
}
export function noticeIdOf(sig: string, project: string, count: number): string { return textHash(`notice:${sig}:${project}:${count}`); }
export function deliverySetHash(items: readonly DeliveryItem[]): string {
  return textHash(JSON.stringify(items.map((item) => `${item.type}:${item.id}`).sort()));
}

export interface OpenEpisode {
  readonly subject: string;
  readonly sig: string;
  readonly callKey: string;
}

export class EpisodeTracker {
  private readonly open = new Map<string, OpenEpisode>();

  has(subject: string, sig: string): boolean { return this.open.has(`${subject}\u0000${sig}`); }

  failure(subject: string, sig: string, callKey: string): boolean {
    const key = `${subject}\u0000${sig}`;
    if (this.open.has(key)) return false;
    this.open.set(key, { subject, sig, callKey });
    return true;
  }

  success(subject: string, callKey: string): OpenEpisode[] {
    return this.close((episode) => episode.subject === subject && episode.callKey === callKey);
  }

  end(subject?: string): OpenEpisode[] {
    return this.close((episode) => subject === undefined || episode.subject === subject);
  }

  private close(test: (episode: OpenEpisode) => boolean): OpenEpisode[] {
    const closed: OpenEpisode[] = [];
    for (const [key, episode] of this.open) {
      if (test(episode)) { this.open.delete(key); closed.push(episode); }
    }
    return closed;
  }
}

export interface RuleState {
  readonly ruleId: string;
  readonly key: RuleKey;
  readonly tool: string;
  readonly head: string;
  readonly cls: string;
  readonly label?: number;
  readonly labelFacts?: EpisodeRecord["labelFacts"];
  readonly count: number;
  readonly ineffective: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly projects: ReadonlySet<string>;
  readonly active: boolean;
}

export const RULE_ACTIVE_EPISODES = 2;

export function qualifyRules(records: Iterable<LedgerV2Record>, sigVersion = SIG_VERSION): Map<string, RuleState> {
  const byRule = new Map<string, EpisodeRecord[]>();
  const seen = new Set<string>();
  for (const record of records) {
    if (record.kind !== "episode" || record.cls === "hook_block" || record.status !== "counted" || record.sigV !== sigVersion) continue;
    if (seen.has(record.opId)) continue;
    seen.add(record.opId);
    const list = byRule.get(record.ruleId);
    if (list) list.push(record); else byRule.set(record.ruleId, [record]);
  }
  const rules = new Map<string, RuleState>();
  for (const [ruleId, episodes] of byRule) {
    const sorted = [...episodes].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    const first = sorted[0];
    const labelled = sorted.find((episode) => episode.label !== undefined);
    rules.set(ruleId, {
      ruleId, key: first.key, tool: first.tool, head: first.head, cls: first.cls,
      ...(labelled?.label !== undefined ? { label: labelled.label } : {}),
      ...(first.labelFacts ? { labelFacts: first.labelFacts } : {}),
      count: sorted.length, ineffective: 0,
      firstAt: first.at, lastAt: sorted[sorted.length - 1].at,
      projects: new Set(sorted.map((episode) => episode.project)), active: sorted.length >= RULE_ACTIVE_EPISODES,
    });
  }
  return rules;
}

export interface RosterTarget {
  readonly executor: string;
  readonly model: string;
  readonly effort: string;
  readonly role: string;
}

export function targetKeyOf(target: RosterTarget): string {
  return [target.executor, target.model, target.effort, target.role].join("\u0000");
}

export function deliverableRules(rules: Iterable<RuleState>, conductorModel: string, roster: readonly RosterTarget[]): RuleState[] {
  const inRoster = new Set(roster.map(targetKeyOf));
  return [...rules].filter((rule) => rule.active && (rule.key.bind === "conductor"
    ? rule.key.model === conductorModel
    : inRoster.has(targetKeyOf(rule.key))));
}

export const OBSERVATION_FRESH_DAYS = 30;
const DAY_MS = 86_400_000;

export interface ClaimItem {
  readonly itemId: string;
  readonly source: ClaimRecord["source"];
  readonly executor: string;
  readonly model: string;
  readonly effort: string;
  readonly role: string;
  readonly text: string;
  readonly freshAt: string;
  readonly corroborated: boolean;
  readonly projects: ReadonlySet<string>;
}

function latest(values: readonly string[]): string | undefined {
  return values.reduce<string | undefined>((max, value) => max === undefined || value > max ? value : max, undefined);
}

export function qualifyClaims(records: Iterable<LedgerV2Record>, now: string, listed: (executor: string, model: string) => boolean, roles: ReadonlySet<string> = new Set(["worker", "explorer", "reviewer"])): ClaimItem[] {
  const all = [...records], complete = completedPublicClaims(all);
  const completeClaims = all.filter((record): record is ClaimRecord => record.kind === "claim" && (record.source !== "public" || complete.has(record.opId)))
    .sort((a, b) => a.at.localeCompare(b.at) || a.opId.localeCompare(b.opId));
  const latestResearch = new Map<string, string>();
  for (const claim of completeClaims) if (claim.source === "public" && claim.research !== undefined) latestResearch.set(`${claim.executor}\u0000${claim.model}`, claim.research);
  const claims = completeClaims.filter(record => !privateTextR06(record.text) && record.role !== "unknown" && record.role !== "child"
    && !/[:/]/.test(record.role) && (record.role === "general" || roles.has(record.role)));
  const byItem = new Map<string, ClaimRecord[]>();
  for (const claim of claims) {
    if (claim.source === "public" && claim.research !== latestResearch.get(`${claim.executor}\u0000${claim.model}`)) continue;
    const list = byItem.get(claim.itemId);
    if (list) list.push(claim); else byItem.set(claim.itemId, [claim]);
  }
  const items: ClaimItem[] = [];
  for (const [itemId, list] of byItem) {
    const first = list[0];
    if (!listed(first.executor, first.model)) continue;
    const corroborations = list.flatMap((claim) => {
      const credited = new Set(claim.evidence.creditedRunIds);
      const at = latest(claim.evidence.runs.filter((run) => credited.has(run.runId)).map((run) => run.endAt));
      return at === undefined ? [] : [at];
    });
    const freshAt = latest(corroborations) ?? first.at;
    if (first.source === "observation" && Date.parse(now) - Date.parse(freshAt) > OBSERVATION_FRESH_DAYS * DAY_MS) continue;
    items.push({ itemId, source: first.source, executor: first.executor, model: first.model, effort: first.effort, role: first.role,
      text: first.text, freshAt, corroborated: corroborations.length > 0, projects: new Set(list.map((claim) => claim.project)) });
  }
  return items;
}

export function completedPublicClaims(records: readonly LedgerV2Record[]): Set<string> {
  const accepted = new Set<string>();
  for (const completion of records) {
    if (completion.kind !== "research-complete") continue;
    const claims = records.filter((r): r is ClaimRecord => r.kind === "claim" && r.source === "public" && r.research === completion.research
      && r.conversation === completion.conversation && r.requestId === completion.requestId);
    if (claims.length !== completion.items.length || claims.some(r => r.inputHash !== completion.inputHash)
      || new Set(completion.items.map(item => item.itemId)).size !== completion.items.length
      || !completion.items.every(item => claims.some(c => c.itemId === item.itemId && c.hash === item.hash))) continue;
    claims.forEach(c => accepted.add(c.opId));
  }
  return accepted;
}

export interface ProjectNotice {
  readonly id: string;
  readonly sig: string;
  readonly tool: string;
  readonly head: string;
  readonly cls: string;
  readonly count: number;
  readonly lastAt: string;
}

export const PROJECT_NOTICE_EPISODES = 2;

export function projectNotices(records: Iterable<LedgerV2Record>, project: string, deliveredNoticeIds: ReadonlySet<string>, sigVersion = SIG_VERSION): ProjectNotice[] {
  const bySig = new Map<string, EpisodeRecord[]>();
  const seen = new Set<string>();
  for (const record of records) {
    if (record.kind !== "episode" || record.cls === "hook_block" || record.status !== "project" || record.project !== project || record.sigV !== sigVersion) continue;
    if (seen.has(record.opId)) continue;
    seen.add(record.opId);
    const list = bySig.get(record.sig);
    if (list) list.push(record); else bySig.set(record.sig, [record]);
  }
  const notices: ProjectNotice[] = [];
  for (const [sig, list] of bySig) {
    if (list.length < PROJECT_NOTICE_EPISODES) continue;
    const id = noticeIdOf(sig, project, list.length);
    if (deliveredNoticeIds.has(id)) continue;
    const first = list[0];
    notices.push({ id, sig, tool: first.tool, head: first.head, cls: first.cls, count: list.length, lastAt: latest(list.map((episode) => episode.at)) ?? first.at });
  }
  return notices.sort((a, b) => a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.id < b.id ? -1 : 1);
}
