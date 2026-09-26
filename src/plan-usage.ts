import type { AssistantUsage } from "./protocol";
import type { RequestBlockRecord } from "./time-buckets";

export interface PlanTokenTotal { tokens: number; cacheRead: number }
export interface PlanUsageSlice extends PlanTokenTotal { start: number; end: number }
export interface PlanUsageBlock extends PlanTokenTotal { blockId: string; slices: PlanUsageSlice[] }
export interface PlanUsage { blocks: PlanUsageBlock[] }
export interface PlanUsageAccumulator {
  messages: Record<string, { at: number; usage: AssistantUsage }>;
}

export function foldPlanUsage(state: PlanUsageAccumulator | undefined, messageId: string, at: number, usage: AssistantUsage): PlanUsageAccumulator {
  const messages = state?.messages ?? {};
  const previous = messages[messageId];
  const merged = { ...previous?.usage };
  for (const key of ["inputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "outputTokens"] as const) {
    const value = usage[key];
    if (value !== undefined && Number.isFinite(value) && value >= 0) merged[key] = Math.max(merged[key] ?? 0, value);
  }
  return { messages: { ...messages, [messageId]: { at: previous?.at ?? at, usage: merged } } };
}

export function projectPlanUsage(state: PlanUsageAccumulator | undefined, blocks: readonly RequestBlockRecord[]): PlanUsage {
  const result: PlanUsage = { blocks: blocks.map(block => ({ blockId: block.blockId, tokens: 0, cacheRead: 0, slices: [] })) };
  for (const { at, usage } of Object.values(state?.messages ?? {})) {
    const index = blocks.findIndex((block, i) => at >= block.start && (i + 1 === blocks.length || at < blocks[i + 1].start));
    if (index < 0) continue;
    const block = result.blocks[index];
    const start = Math.max(blocks[index].start, Math.floor(at / 1000) * 1000);
    const end = Math.min(start + 1000, blocks[index + 1]?.start ?? Infinity);
    let slice = block.slices.find(value => value.start === start);
    if (!slice) { slice = { start, end, tokens: 0, cacheRead: 0 }; block.slices.push(slice); }
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

// messageCount は数値を持つ応答、unmeasuredMessageCount は usage はあるが数値を 1 つも持たない応答。
// usage そのものが無い応答は assistant_usage を生まないので数えられない
export interface MainTokenTotal extends PlanTokenTotal { messageCount: number; unmeasuredMessageCount: number; partial: boolean }

// assistant_usage はメインの記録だけ（サブエージェントは発行しない）なので、これはセッション全体の本体分。
// 数値の観測が 1 件も無ければ null（空の usage を測った 0 にしない。R-DSP-11）
export function summarizeMainTokens(state: PlanUsageAccumulator | undefined): MainTokenTotal | null {
  let tokens = 0;
  let cacheRead = 0;
  let messageCount = 0;
  let unmeasuredMessageCount = 0;
  for (const { usage } of Object.values(state?.messages ?? {})) {
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
