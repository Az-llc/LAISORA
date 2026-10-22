import { CACHE_TTL_MS, cacheWriteTtl } from "./cache-ttl-cost";
import type { CacheTtl } from "./claude-prices";
import { configurationDefault } from "./configuration-defaults";
import { askBlocksIn } from "./markdown-ast";
import { planCurrentSteps } from "./plan-steps";
import type { HandoffNoticeFacts } from "./steering-envelope";
import {
  HANDOFF_AUTO_SETTING_KEYS,
  isHandoffAutoSettingValue,
  type AssistantUsage,
  type HandoffContextUsage,
  type HandoffAutoSettingName,
  type HandoffAutoSettings,
  type HandoffAutoNotice,
  type HandoffAutoStart,
  type NormalizedEvent,
} from "./protocol";

export const CACHE_EXPIRY_LEAD_MS = 5 * 60_000;
export const CACHE_EXPIRY_MIN_TOTAL_TOKENS = 100_000;

export function resolveHandoffAutoSettings(read: (key: string) => unknown): HandoffAutoSettings {
  const pick = <K extends HandoffAutoSettingName>(name: K): HandoffAutoSettings[K] => {
    const key = HANDOFF_AUTO_SETTING_KEYS[name];
    const value = read(key);
    return (isHandoffAutoSettingValue(name, value) ? value : configurationDefault<HandoffAutoSettings[K]>(key)) as HandoffAutoSettings[K];
  };
  return { enabled: pick("enabled"), mode: pick("mode"), percent: pick("percent"), tokens: pick("tokens"), cacheExpiryEnabled: pick("cacheExpiryEnabled") };
}

const measured = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function autoHandoffThreshold(settings: Pick<HandoffAutoSettings, "mode" | "percent" | "tokens">, autoCompactThreshold: number | undefined): number | undefined {
  if (!measured(autoCompactThreshold)) return undefined;
  return settings.mode === "ratio" ? Math.floor(autoCompactThreshold * settings.percent / 100) : Math.min(settings.tokens, autoCompactThreshold);
}

export type HandoffOrigin = { postTokens: number | undefined } | undefined;

export function sizeAutoStart(settings: HandoffAutoSettings, usage: { totalTokens?: number; autoCompactThreshold?: number }, origin: HandoffOrigin): Extract<HandoffAutoStart, { trigger: "size" }> | undefined {
  if (!settings.enabled || !measured(usage.totalTokens)) return undefined;
  const threshold = autoHandoffThreshold(settings, usage.autoCompactThreshold);
  if (threshold === undefined || usage.totalTokens < threshold) return undefined;
  if (origin !== undefined && (origin.postTokens === undefined || origin.postTokens > threshold / 2)) return undefined;
  return { trigger: "size", totalTokens: usage.totalTokens, threshold };
}

export function handoffOriginOf(source: { contextUsage?: HandoffContextUsage } | undefined): HandoffOrigin {
  if (source === undefined) return undefined;
  const after = source.contextUsage?.after;
  return { postTokens: typeof after === "object" && after !== null ? after.totalTokens : undefined };
}

export function postTurnMeasurement(measuredAfterTurnEnds: number, turnEnds: number): boolean {
  return measuredAfterTurnEnds === turnEnds;
}

export function cacheTtlOfUsage(usage: AssistantUsage | undefined): CacheTtl | undefined {
  return usage === undefined ? undefined : cacheWriteTtl([usage]) ?? undefined;
}

export function cacheExpiryDeadline(response: { at: number; usage: AssistantUsage } | undefined): { at: number; expiresAt: number } | undefined {
  if (response === undefined || cacheTtlOfUsage(response.usage) !== "1h") return undefined;
  const expiresAt = response.at + CACHE_TTL_MS["1h"];
  return { at: expiresAt - CACHE_EXPIRY_LEAD_MS, expiresAt };
}

export function cacheExpiryAutoStart(input: {
  settings: HandoffAutoSettings;
  totalTokens: number | undefined;
  response: { at: number; usage: AssistantUsage } | undefined;
  lastUserSendAt: number | undefined;
  unfinishedWork: boolean;
  now: number;
}): Extract<HandoffAutoStart, { trigger: "cache_expiry" }> | undefined {
  const deadline = cacheExpiryDeadline(input.response);
  if (!input.settings.cacheExpiryEnabled || deadline === undefined || !measured(input.totalTokens)) return undefined;
  if (input.totalTokens < CACHE_EXPIRY_MIN_TOTAL_TOKENS || !input.unfinishedWork) return undefined;
  if (input.lastUserSendAt !== undefined && input.lastUserSendAt >= input.response!.at) return undefined;
  if (input.now < deadline.at || input.now >= deadline.expiresAt) return undefined;
  return { trigger: "cache_expiry", totalTokens: input.totalTokens, expiresAt: deadline.expiresAt };
}

export interface CurrentAutoStartInput {
  settings: HandoffAutoSettings;
  usage: { totalTokens?: number; autoCompactThreshold?: number };
  origin: HandoffOrigin;
  noticeSent: boolean;
  now: number;
}

export function currentAutoStart(candidate: HandoffAutoStart, input: CurrentAutoStartInput): HandoffAutoStart | undefined {
  if (candidate.trigger === "size") return sizeAutoStart(input.settings, input.usage, input.origin);
  if (!input.settings.cacheExpiryEnabled || !measured(input.usage.totalTokens)) return undefined;
  const expiresAt = candidate.expiresAt !== undefined && input.now < candidate.expiresAt ? candidate.expiresAt : undefined;
  if (!input.noticeSent && expiresAt === undefined) return undefined;
  return { trigger: "cache_expiry", totalTokens: input.usage.totalTokens, ...(expiresAt === undefined ? {} : { expiresAt }) };
}

export function noticedTurnEndCandidate(noticed: HandoffAutoStart["trigger"], usage: { totalTokens: number }, nextCacheExpiresAt: number | undefined): HandoffAutoStart {
  return noticed === "size"
    ? { trigger: "size", totalTokens: usage.totalTokens, threshold: 0 }
    : { trigger: "cache_expiry", totalTokens: usage.totalTokens, ...(nextCacheExpiresAt === undefined ? {} : { expiresAt: nextCacheExpiresAt }) };
}

export function planHasUnfinishedStep(blocks: Parameters<typeof planCurrentSteps>[0]): boolean {
  return planCurrentSteps(blocks).some((step) => step.status === "pending" || step.status === "in_progress");
}

export function decisionPendingSinceUserSend(events: readonly NormalizedEvent[]): boolean {
  const resolved = new Set<string>();
  const texts: string[] = [];
  let turnId: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind === "user_message" || (ev.kind === "replayed_message" && ev.role === "user")) break;
    if (ev.kind === "approval_resolved") resolved.add(ev.requestId);
    else if (ev.kind === "approval_request" && ev.questions !== undefined && !resolved.has(ev.requestId)) return true;
    else if (ev.kind === "replayed_message" && ev.role === "assistant") {
      texts.push("\n", ev.text, "\n");
      turnId = undefined;
    } else if (ev.kind === "assistant_text_delta" && ev.priorGeneration !== true) {
      if (turnId !== undefined && turnId !== ev.turnId) texts.push("\n");
      texts.push(ev.text);
      turnId = ev.turnId;
    }
  }
  return askBlocksIn(texts.reverse().join("")).some((ask) => ask.kind === "decide");
}

export interface AutoHandoffGateInput {
  idle: boolean;
  runningAgents: number;
  runningBackgroundTasks: number;
  runningExternalRuns: number;
  queuedMessages: number;
  composerHasText: boolean;
  handoffRunning: boolean;
}

export function autoHandoffGateOpen(gate: AutoHandoffGateInput): boolean {
  return gate.idle && gate.runningAgents === 0 && gate.runningBackgroundTasks === 0 && gate.runningExternalRuns === 0
    && gate.queuedMessages === 0 && !gate.composerHasText && !gate.handoffRunning;
}

export type HeldCandidateStep = { action: "fire" } | { action: "hold"; heldByBackground: boolean } | { action: "drop" };

export function heldCandidateStep(heldByBackground: boolean, gate: AutoHandoffGateInput): HeldCandidateStep {
  if (autoHandoffGateOpen(gate)) return heldByBackground ? { action: "drop" } : { action: "fire" };
  const relayed = gate.runningAgents > 0 || gate.runningBackgroundTasks > 0;
  return { action: "hold", heldByBackground: heldByBackground || relayed };
}

const QUIET_AUTO_REFUSALS: readonly string[] = ["source_busy", "already_running"];

export function quietAutoRefusal(automatic: boolean, reason: string): boolean {
  return automatic && QUIET_AUTO_REFUSALS.includes(reason);
}

export interface AutoHandoffMemory {
  readonly generation: number;
  readonly started: boolean;
  readonly blocked: boolean;
  readonly userSentWhileBlocked: boolean;
  readonly notice?: { readonly facts: HandoffNoticeFacts; readonly at: number };
}

export function autoHandoffMemoryFor(memory: AutoHandoffMemory | undefined, generation: number): AutoHandoffMemory {
  return memory !== undefined && memory.generation === generation
    ? memory
    : { generation, started: false, blocked: false, userSentWhileBlocked: false };
}

export function autoHandoffAllowed(memory: AutoHandoffMemory): boolean {
  return !memory.started && !memory.blocked;
}

export function noteAutoHandoffStarted(memory: AutoHandoffMemory): AutoHandoffMemory {
  return { ...memory, started: true };
}

function withinNoticeLifetime(from: number, to: number): boolean {
  return to - from < CACHE_TTL_MS["1h"];
}

export function activeNotice(memory: AutoHandoffMemory, now: number): HandoffNoticeFacts | undefined {
  const notice = memory.notice;
  return notice !== undefined && withinNoticeLifetime(notice.at, now) ? notice.facts : undefined;
}

export function autoStartAction(memory: AutoHandoffMemory, now: number): "notice" | "handoff" {
  return activeNotice(memory, now) === undefined ? "notice" : "handoff";
}

export function noticeTrigger(facts: HandoffNoticeFacts): HandoffAutoStart["trigger"] {
  return facts.reason === "size" ? "size" : "cache_expiry";
}

export function noteHandoffNoticeSent(memory: AutoHandoffMemory, facts: HandoffNoticeFacts, at: number): AutoHandoffMemory {
  return { ...memory, notice: { facts, at } };
}

export function noteTurnEndAfterNotice(memory: AutoHandoffMemory, at: number): AutoHandoffMemory {
  const notice = memory.notice;
  if (notice === undefined || notice.at >= at) return memory;
  if (!withinNoticeLifetime(notice.at, at)) {
    const { notice: _stale, ...rest } = memory;
    return rest;
  }
  return { ...memory, notice: { ...notice, at } };
}

export function noticeInEvents(events: readonly NormalizedEvent[]): { facts: HandoffNoticeFacts; at: number; stopped: boolean } | undefined {
  let index = -1;
  for (let i = events.length - 1; i >= 0 && index < 0; i--) {
    const ev = events[i];
    if (ev.kind === "local_command_output" && ev.priorGeneration !== true && ev.handoffNotice !== undefined) index = i;
  }
  if (index < 0) return undefined;
  const card = events[index] as Extract<NormalizedEvent, { kind: "local_command_output" }>;
  let at = card.timestamp;
  for (let i = index + 1; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind !== "turn_completed" || ev.timestamp <= at) continue;
    if (!withinNoticeLifetime(at, ev.timestamp)) break;
    at = ev.timestamp;
  }
  return { facts: card.handoffNotice!, at, stopped: card.handoffNoticeStopped === true };
}

export function autoStartDisplay(start: HandoffAutoStart, notice: HandoffNoticeFacts | undefined, noticeReason: (facts: HandoffNoticeFacts) => string): HandoffAutoStart | HandoffAutoNotice {
  return notice !== undefined && noticeTrigger(notice) === start.trigger ? { trigger: "notice", reason: noticeReason(notice) } : start;
}

export function noteNoticeFromEvents(memory: AutoHandoffMemory, events: readonly NormalizedEvent[]): AutoHandoffMemory {
  const found = noticeInEvents(events);
  if (found === undefined) return memory;
  const known = memory.notice !== undefined && memory.notice.at >= found.at ? memory : noteHandoffNoticeSent(memory, found.facts, found.at);
  return found.stopped ? noteNoticeTurnInterrupted(known) : known;
}

export function noteNoticeTurnInterrupted(memory: AutoHandoffMemory): AutoHandoffMemory {
  return { ...memory, started: true };
}

export function handoffNoticeFactsOf(start: HandoffAutoStart, todoItemId: string | undefined): HandoffNoticeFacts | undefined {
  const item = todoItemId === undefined ? {} : { todoItemId };
  if (start.trigger === "size") return { reason: "size", totalTokens: Math.round(start.totalTokens), threshold: Math.round(start.threshold), ...item };
  return start.expiresAt === undefined ? undefined : { reason: "cache_expiry", totalTokens: Math.round(start.totalTokens), expiresAt: Math.round(start.expiresAt), ...item };
}

export function noteAutoHandoffRefused(memory: AutoHandoffMemory): AutoHandoffMemory {
  return { ...memory, started: false };
}

export function noteHandoffSettled(memory: AutoHandoffMemory, completed: boolean): AutoHandoffMemory {
  return completed ? { ...memory, started: true } : { ...memory, blocked: true, userSentWhileBlocked: false };
}

export function autoHandoffPermitted(memory: AutoHandoffMemory, sessionId: string | undefined, handedOffSources: readonly string[]): boolean {
  return autoHandoffAllowed(memory) && sessionId !== undefined && !handedOffSources.includes(sessionId);
}

export const HANDED_OFF_SOURCES_KEY = "laisora.handoff.handedOffSources.v1";
export const HANDED_OFF_SOURCES_MAX = 2000;

export function handedOffSourcesOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

export function rememberHandedOffSource(raw: unknown, sessionId: string, max = HANDED_OFF_SOURCES_MAX): { list: string[]; dropped: string[] } {
  const list = [...handedOffSourcesOf(raw).filter((id) => id !== sessionId), sessionId];
  const dropped = list.length > max ? list.splice(0, list.length - max) : [];
  return { list, dropped };
}

export function noteUserSend(memory: AutoHandoffMemory): AutoHandoffMemory {
  return memory.blocked ? { ...memory, userSentWhileBlocked: true } : memory;
}

export function noteTurnCompleted(memory: AutoHandoffMemory): AutoHandoffMemory {
  return memory.blocked && memory.userSentWhileBlocked ? { ...memory, blocked: false, userSentWhileBlocked: false } : memory;
}
