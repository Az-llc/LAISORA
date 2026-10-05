import type { AssistantUsage } from "./protocol";
import type { RequestBlockRecord } from "./time-buckets";

export interface PlanTokenTotal { tokens: number; cacheRead: number }
export interface PlanUsageSlice extends PlanTokenTotal { start: number; end: number }
export interface PlanUsageBlock extends PlanTokenTotal { blockId: string; slices: PlanUsageSlice[] }
export interface PlanUsage { blocks: PlanUsageBlock[] }
interface UsageMessage { at: number; usage: AssistantUsage }
interface UsageEntry { id: string; value: UsageMessage; previous: number | undefined }
interface UsageLog { entries: UsageEntry[]; heads: Map<string, number> }

export class PlanUsageAccumulator {
  private constructor(private readonly log: UsageLog, private readonly length: number) {}

  static empty(): PlanUsageAccumulator { return new PlanUsageAccumulator({ entries: [], heads: new Map() }, 0); }

  get(messageId: string): UsageMessage | undefined {
    let index = this.log.heads.get(messageId);
    while (index !== undefined && index >= this.length) index = this.log.entries[index].previous;
    return index === undefined ? undefined : this.log.entries[index].value;
  }

  withMessage(messageId: string, value: UsageMessage): PlanUsageAccumulator {
    let log = this.log;
    if (this.length !== log.entries.length) {
      const entries = log.entries.slice(0, this.length);
      const heads = new Map<string, number>();
      entries.forEach((entry, index) => heads.set(entry.id, index));
      log = { entries, heads };
    }
    log.entries.push({ id: messageId, value, previous: log.heads.get(messageId) });
    log.heads.set(messageId, this.length);
    return new PlanUsageAccumulator(log, this.length + 1);
  }

  *values(): IterableIterator<UsageMessage> {
    const seen = new Set<string>();
    for (let index = this.length - 1; index >= 0; index--) {
      const entry = this.log.entries[index];
      if (!seen.has(entry.id)) { seen.add(entry.id); yield entry.value; }
    }
  }
}

export function foldPlanUsage(state: PlanUsageAccumulator | undefined, messageId: string, at: number, usage: AssistantUsage): PlanUsageAccumulator {
  const accumulator = state ?? PlanUsageAccumulator.empty();
  const previous = accumulator.get(messageId);
  const merged = { ...previous?.usage };
  for (const key of ["inputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "outputTokens"] as const) {
    const value = usage[key];
    if (value !== undefined && Number.isFinite(value) && value >= 0) merged[key] = Math.max(merged[key] ?? 0, value);
  }
  return accumulator.withMessage(messageId, { at: previous?.at ?? at, usage: merged });
}

export function projectPlanUsage(state: PlanUsageAccumulator | undefined, blocks: readonly Pick<RequestBlockRecord, "blockId" | "start">[]): PlanUsage {
  const result: PlanUsage = { blocks: blocks.map(block => ({ blockId: block.blockId, tokens: 0, cacheRead: 0, slices: [] })) };
  const slices = blocks.map(() => new Map<number, PlanUsageSlice>());
  for (const { at, usage } of state?.values() ?? []) {
    if (usage.inputTokens === undefined && usage.cacheCreationInputTokens === undefined && usage.outputTokens === undefined) continue;
    let low = 0;
    let high = blocks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (blocks[middle].start <= at) low = middle + 1;
      else high = middle;
    }
    const index = low - 1;
    if (index < 0) continue;
    const block = result.blocks[index];
    const start = Math.max(blocks[index].start, Math.floor(at / 1000) * 1000);
    const end = Math.min(start + 1000, blocks[index + 1]?.start ?? Infinity);
    let slice = slices[index].get(start);
    if (!slice) { slice = { start, end, tokens: 0, cacheRead: 0 }; slices[index].set(start, slice); block.slices.push(slice); }
    const tokens = (usage.inputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) + (usage.outputTokens ?? 0);
    const cacheRead = usage.cacheReadInputTokens ?? 0;
    slice.tokens += tokens;
    slice.cacheRead += cacheRead;
    block.tokens += tokens;
    block.cacheRead += cacheRead;
  }
  for (const block of result.blocks) block.slices.sort((a, b) => a.start - b.start);
  return result;
}

export interface MainTokenTotal extends PlanTokenTotal { messageCount: number; unmeasuredMessageCount: number; partial: boolean }

export function summarizeMainTokens(state: PlanUsageAccumulator | undefined): MainTokenTotal | null {
  let tokens = 0;
  let cacheRead = 0;
  let messageCount = 0;
  let unmeasuredMessageCount = 0;
  for (const { usage } of state?.values() ?? []) {
    if (usage.inputTokens === undefined && usage.cacheCreationInputTokens === undefined && usage.outputTokens === undefined) {
      unmeasuredMessageCount++;
      continue;
    }
    messageCount++;
    tokens += (usage.inputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) + (usage.outputTokens ?? 0);
    cacheRead += usage.cacheReadInputTokens ?? 0;
  }
  if (messageCount === 0) return null;
  return { tokens, cacheRead, messageCount, unmeasuredMessageCount, partial: unmeasuredMessageCount > 0 };
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function count(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function isPlanUsage(value: unknown): value is PlanUsage {
  return exact(value, ["blocks"]) && Array.isArray(value.blocks) && value.blocks.every(block =>
    exact(block, ["blockId", "tokens", "cacheRead", "slices"]) && typeof block.blockId === "string"
    && count(block.tokens) && count(block.cacheRead) && Array.isArray(block.slices) && block.slices.every(slice =>
      exact(slice, ["start", "end", "tokens", "cacheRead"]) && count(slice.start) && count(slice.end)
      && slice.end >= slice.start && count(slice.tokens) && count(slice.cacheRead)));
}
