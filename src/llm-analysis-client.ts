import { createHash } from "node:crypto";
import { ACTION_DESTINATIONS, ACTION_KINDS } from "./llm-action-policy";
import type { CitationAliasTable } from "./llm-citation-alias";
import type { LlmAnalysisInput, NumericFactTable } from "./llm-analysis-input";
import {
  LLM_INPUT_BUDGET_TOKENS,
  LLM_MAX_CALLS,
  LLM_PER_CALL_TIMEOUT_MS,
  LLM_RESERVED_TOKENS,
  estTokens,
  renderCitedExcerpts,
  renderFactsSection,
} from "./llm-analysis-input";
import { SEMANTIC_MODEL_SPEC_VERSION } from "./semantic-model";
import type {
  ActionFinding,
  ActionFindingVerificationResult,
  FindingVerificationModel,
  LlmAnalysisProvenance,
} from "./llm-finding-verify";
import { verifyActionFindings } from "./llm-finding-verify";
import type { LlmAnalysisOutputLanguage } from "./llm-analysis-prompt";


export interface LlmAnalysisRequest {
  promptVersion: string;
  outputLanguage: LlmAnalysisOutputLanguage;
  modelId: string;
  prompt: string;
  signal: AbortSignal;
  onActivity?: () => void;
}

export interface LlmAnalysisGenerateResult {
  output: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  models?: string[];
}

export interface LlmAnalysisClient {
  readonly modelId: string;
  generate(request: LlmAnalysisRequest): Promise<LlmAnalysisGenerateResult>;
}

export type LlmFindingShapeRejectionReason =
  | "not_an_object"
  | "missing_field"
  | "field_type_mismatch"
  | "enum_value_invalid"
  | "arity_mismatch"
  | "string_too_short"
  | "unreadable_value";

export interface LlmFindingShapeRejection {
  stage: "schema";
  reason: LlmFindingShapeRejectionReason;
  path: string;
  index: number;
  detail?: Record<string, number | string>;
}

export type ActionFindingParseOutcome =
  | { state: "malformed"; reason: "not_an_array" }
  | {
      state: "parsed";
      candidateCount: number;
      findings: ActionFinding[];
      rejections: LlmFindingShapeRejection[];
    };

export type ValueSpec =
  | { t: "string"; minLength?: number }
  | { t: "enum"; values: readonly string[] }
  | { t: "finite"; min?: number; integer?: boolean }
  | { t: "array"; of: ValueSpec; minItems?: number; maxItems?: number; length?: number }
  | { t: "object"; fields: readonly FieldSpec[] };

export interface FieldSpec {
  key: string;
  optional?: true;
  spec: ValueSpec;
}

export const CALCULATION_FIELDS: readonly FieldSpec[] = [
  { key: "op", spec: { t: "enum", values: ["identity", "sum", "cardinality"] } },
  { key: "factIds", spec: { t: "array", of: { t: "string" }, minItems: 1 } },
];

export const IMPACT_FIELDS: readonly FieldSpec[] = [
  { key: "unit", spec: { t: "enum", values: ["ms", "count"] } },
  { key: "value", spec: { t: "finite", min: 0, integer: true } },
  { key: "calculation", spec: { t: "object", fields: CALCULATION_FIELDS } },
];

export const ACTION_FIELDS: readonly FieldSpec[] = [
  { key: "kind", spec: { t: "enum", values: ACTION_KINDS } },
  { key: "steps", spec: { t: "array", of: { t: "string", minLength: 8 }, minItems: 1 } },
  { key: "destination", spec: { t: "enum", values: ACTION_DESTINATIONS } },
  { key: "target", optional: true, spec: { t: "string" } },
];

export const ACTION_FINDING_FIELDS: readonly FieldSpec[] = [
  { key: "title", spec: { t: "string", minLength: 4 } },
  { key: "observed", spec: { t: "string", minLength: 8 } },
  { key: "impact", spec: { t: "object", fields: IMPACT_FIELDS } },
  { key: "action", spec: { t: "object", fields: ACTION_FIELDS } },
  { key: "evidenceIds", spec: { t: "array", of: { t: "string" }, minItems: 1 } },
  { key: "confidence", spec: { t: "enum", values: ["high", "medium", "low"] } },
];

interface ShapeCtx {
  index: number;
  out: LlmFindingShapeRejection[];
}

function reject(
  ctx: ShapeCtx,
  reason: LlmFindingShapeRejectionReason,
  path: string,
  detail?: Record<string, number | string>
): false {
  ctx.out.push(
    detail === undefined
      ? { stage: "schema", reason, path, index: ctx.index }
      : { stage: "schema", reason, path, index: ctx.index, detail }
  );
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkValue(value: unknown, spec: ValueSpec, path: string, ctx: ShapeCtx): boolean {
  switch (spec.t) {
    case "string":
      if (typeof value !== "string") return reject(ctx, "field_type_mismatch", path);
      if (spec.minLength !== undefined && value.trim().length < spec.minLength) {
        return reject(ctx, "string_too_short", path, { minLength: spec.minLength, actualLength: value.trim().length });
      }
      return true;
    case "enum":
      if (typeof value !== "string") return reject(ctx, "field_type_mismatch", path);
      return spec.values.includes(value) ? true : reject(ctx, "enum_value_invalid", path);
    case "finite":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return reject(ctx, "field_type_mismatch", path);
      }
      if (spec.min !== undefined && value < spec.min) {
        return reject(ctx, "field_type_mismatch", path);
      }
      if (spec.integer === true && !Number.isInteger(value)) {
        return reject(ctx, "field_type_mismatch", path);
      }
      return true;
    case "array": {
      if (!Array.isArray(value)) return reject(ctx, "field_type_mismatch", path);
      if (spec.length !== undefined && value.length !== spec.length) {
        return reject(ctx, "arity_mismatch", path, { expected: spec.length, actual: value.length });
      }
      if (spec.minItems !== undefined && value.length < spec.minItems) {
        return reject(ctx, "arity_mismatch", path, { minItems: spec.minItems, actual: value.length });
      }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        return reject(ctx, "arity_mismatch", path, { maxItems: spec.maxItems, actual: value.length });
      }
      let ok = true;
      for (let i = 0; i < value.length; i++) {
        if (!checkValue(value[i], spec.of, path + "[" + String(i) + "]", ctx)) ok = false;
      }
      return ok;
    }
    case "object":
      return isRecord(value)
        ? checkFields(value, spec.fields, path, ctx)
        : reject(ctx, "not_an_object", path);
  }
}

function checkFields(
  host: Record<string, unknown>,
  fields: readonly FieldSpec[],
  path: string,
  ctx: ShapeCtx
): boolean {
  let ok = true;
  for (const field of fields) {
    const fieldPath = path === "" ? field.key : path + "." + field.key;
    const value = host[field.key];
    if (value === undefined) {
      if (field.optional === true) continue;
      reject(ctx, "missing_field", fieldPath);
      ok = false;
      continue;
    }
    if (!checkValue(value, field.spec, fieldPath, ctx)) ok = false;
  }
  return ok;
}

function checkActionFinding(raw: unknown, ctx: ShapeCtx): boolean {
  if (!isRecord(raw)) return reject(ctx, "not_an_object", "");
  return checkFields(raw, ACTION_FINDING_FIELDS, "", ctx);
}

export function parseActionFindings(value: unknown): ActionFindingParseOutcome {
  let list: unknown = value;
  if (isRecord(value) && Array.isArray(value.findings)) {
    list = value.findings;
  }
  if (!Array.isArray(list)) return { state: "malformed", reason: "not_an_array" };
  const findings: ActionFinding[] = [];
  const rejections: LlmFindingShapeRejection[] = [];
  for (let index = 0; index < list.length; index++) {
    const ctx: ShapeCtx = { index, out: rejections };
    const raw: unknown = list[index];
    let ok: boolean;
    try {
      ok = checkActionFinding(raw, ctx);
    } catch {
      ok = reject(ctx, "unreadable_value", "");
    }
    if (ok) findings.push(raw as ActionFinding);
  }
  return { state: "parsed", candidateCount: list.length, findings, rejections };
}

export function valueSpecToJsonSchema(spec: ValueSpec): Record<string, unknown> {
  switch (spec.t) {
    case "string": {
      const schema: Record<string, unknown> = { type: "string" };
      if (spec.minLength !== undefined) schema.minLength = spec.minLength;
      return schema;
    }
    case "enum":
      return { type: "string", enum: [...spec.values] };
    case "finite": {
      const schema: Record<string, unknown> = { type: spec.integer ? "integer" : "number" };
      if (spec.min !== undefined) schema.minimum = spec.min;
      return schema;
    }
    case "array": {
      const schema: Record<string, unknown> = {
        type: "array",
        items: valueSpecToJsonSchema(spec.of),
      };
      if (spec.length !== undefined) {
        schema.minItems = spec.length;
        schema.maxItems = spec.length;
      }
      if (spec.minItems !== undefined) schema.minItems = spec.minItems;
      if (spec.maxItems !== undefined) schema.maxItems = spec.maxItems;
      return schema;
    }
    case "object": {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const field of spec.fields) {
        properties[field.key] = valueSpecToJsonSchema(field.spec);
        if (field.optional !== true) {
          required.push(field.key);
        }
      }
      return {
        type: "object",
        properties,
        required,
      };
    }
  }
}

export function llmFindingsJsonSchema(): Record<string, unknown> {
  const findingSchema = valueSpecToJsonSchema({ t: "object", fields: ACTION_FINDING_FIELDS });
  return {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: findingSchema,
      },
      summary: {
        type: "string",
      },
    },
    required: ["findings"],
    additionalProperties: false,
  };
}

export interface LlmSchemaStageDiagnostics {
  candidateCount: number;
  rejectedCount: number;
  byReason: Partial<Record<LlmFindingShapeRejectionReason, number>>;
  rejections: readonly LlmFindingShapeRejection[];
}

function schemaDiagnosticsOf(
  candidateCount: number,
  acceptedCount: number,
  rejections: readonly LlmFindingShapeRejection[]
): LlmSchemaStageDiagnostics {
  const byReason: Partial<Record<LlmFindingShapeRejectionReason, number>> = {};
  for (const rejection of rejections) {
    byReason[rejection.reason] = (byReason[rejection.reason] ?? 0) + 1;
  }
  return {
    candidateCount,
    rejectedCount: candidateCount - acceptedCount,
    byReason,
    rejections,
  };
}

import type { EffortLevel } from "./analysis-persistence";

export interface LlmFindingCacheKey {
  specVersion: number;
  model: { kind: "explicit"; value: string } | { kind: "unresolved" };
  effort: { kind: "explicit"; value: EffortLevel } | { kind: "unresolved" };
  semanticHash: string;
  inputVersion: string;
  promptVersion: string;
  outputLanguage: LlmAnalysisOutputLanguage;
  contentHash: string;
}

export function computeContentHash(slices: { text: string }[], merge?: { text: string }): string {
  const h = createHash("sha256");
  for (const s of slices) h.update(s.text, "utf8");
  if (merge) h.update(merge.text, "utf8");
  return h.digest("hex").slice(0, 16);
}

export function llmFindingCacheKeyString(key: LlmFindingCacheKey): string {
  return JSON.stringify([
    key.specVersion,
    [key.model.kind, key.model.kind === "explicit" ? key.model.value : ""],
    [key.effort.kind, key.effort.kind === "explicit" ? key.effort.value : ""],
    key.semanticHash,
    key.inputVersion,
    key.promptVersion,
    key.outputLanguage,
    key.contentHash,
  ]);
}

export interface LlmFindingCacheEntry {
  readonly findings: readonly ActionFinding[];
  readonly schema: LlmSchemaStageDiagnostics;
  readonly provenance: LlmAnalysisProvenance;
  readonly usage?: { inputTokens: number; outputTokens: number };
  readonly models: string[] | null;
  readonly slices: number;
  readonly analysisRunId: string;
}

function copyEntry(entry: LlmFindingCacheEntry): LlmFindingCacheEntry {
  return {
    findings: [...entry.findings],
    schema: { ...entry.schema, byReason: { ...entry.schema.byReason }, rejections: [...entry.schema.rejections] },
    provenance: { ...entry.provenance },
    usage: entry.usage ? { ...entry.usage } : undefined,
    models: entry.models ? [...entry.models] : null,
    slices: entry.slices,
    analysisRunId: entry.analysisRunId,
  };
}

export class LlmFindingCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, LlmFindingCacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;
  private coalescedCount = 0;

  constructor(maxEntries = 32) {
    this.maxEntries = maxEntries;
  }

  get(key: LlmFindingCacheKey): LlmFindingCacheEntry | undefined {
    const value = this.entries.get(llmFindingCacheKeyString(key));
    if (value === undefined) {
      this.missCount++;
      return undefined;
    }
    this.hitCount++;
    return copyEntry(value);
  }

  set(key: LlmFindingCacheKey, entry: LlmFindingCacheEntry): void {
    const keyStr = llmFindingCacheKeyString(key);
    const stored = copyEntry(entry);
    if (this.entries.has(keyStr)) {
      this.entries.set(keyStr, stored);
      return;
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.evictionCount++;
    }
    this.entries.set(keyStr, stored);
  }

  join(key: LlmFindingCacheKey, start: () => Promise<unknown>): Promise<unknown> {
    const keyStr = llmFindingCacheKeyString(key);
    const existing = this.inFlight.get(keyStr);
    if (existing !== undefined) {
      this.coalescedCount++;
      return existing;
    }
    const created = start();
    this.inFlight.set(keyStr, created);
    const forget = (): void => {
      if (this.inFlight.get(keyStr) === created) this.inFlight.delete(keyStr);
    };
    created.then(forget, forget);
    return created;
  }

  clear(): void {
    this.entries.clear();
  }

  get stats(): { hits: number; misses: number; size: number; evictions: number; coalesced: number } {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      size: this.entries.size,
      evictions: this.evictionCount,
      coalesced: this.coalescedCount,
    };
  }
}

export type LlmAnalysisUnavailableReason =
  | "no_client"
  | "provenance_mismatch"
  | "prompt_render_error"
  | "client_error"
  | "client_timeout"
  | "client_aborted"
  | "malformed_response"
  | "verification_error";

export type LlmAnalysisTimeoutLimit = "per_call" | "total";

export type LlmAnalysisCallStage = "slice" | "merge";

export interface LlmAnalysisProgress {
  event: "call_started" | "call_finished";
  stage: LlmAnalysisCallStage;
  callIndex: number;
  // 実際に投げる予定の呼び出し数。maxCalls を分母に使うと 2 スライスのとき「1/7」と表示され、
  // 画面が到達しない上限を名乗る
  plannedCalls: number;
  maxCalls: number;
  sliceIndex: number;
  sliceCount: number;
  elapsedMs: number;
}

export interface LlmAnalysisRunDiagnostics {
  mergeInputBudget?: { estimatedTokens: number; budgetTokens: number; templateTokens: number; factsTokens: number; findingsTokens: number; excerptsTokens: number };
  elapsedMs: number;
  attemptedCalls: number;
  completedCalls: number;
  plannedCalls: number;
  maxCalls: number;
  sliceCount: number;
  stage: LlmAnalysisCallStage;
  limit?: LlmAnalysisTimeoutLimit;
}

export type LlmAnalysisOutcome =
  | { state: "disabled" }
  | {
      state: "unavailable";
      reason: LlmAnalysisUnavailableReason;
      cacheState: "hit" | "miss" | "not_attempted";
      run?: LlmAnalysisRunDiagnostics;
    }
  | {
      state: "ready";
      cacheState: "hit" | "miss";
      result: ActionFindingVerificationResult;
      schema: LlmSchemaStageDiagnostics;
      usage?: { inputTokens: number; outputTokens: number };
      models: string[] | null;
      slices: number;
      analysisRunId: string;
      aliases: CitationAliasTable;
      facts: NumericFactTable;
    };

export type LlmAnalysisProvenanceInput = Omit<LlmAnalysisProvenance, "modelId" | "promptVersion">;

export interface LlmAnalysisRunInput {
  enabled: boolean;
  client: LlmAnalysisClient | undefined;
  cache: LlmFindingCache;
  input: LlmAnalysisInput;
  promptVersion: string;
  outputLanguage: LlmAnalysisOutputLanguage;
  model: FindingVerificationModel;
  analysis: { semanticHash: string };
  provenance: LlmAnalysisProvenanceInput;
  requestedModel?: { kind: "explicit"; value: string } | { kind: "unresolved" };
  requestedEffort?: { kind: "explicit"; value: EffortLevel } | { kind: "unresolved" };
  signal?: AbortSignal;
  timeoutMs?: number;
  perCallTimeoutMs?: number;
  onProgress?: (info: LlmAnalysisProgress) => void;
}

const ABORTED = Symbol("aborted");

function boundedTimeoutMs(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected)) return fallback;
  return Math.max(0, Math.min(selected, maximum));
}

function createInactivityWatchdog(timeoutMs: number, onTimeout: () => void): {
  onActivity: () => void;
  stop: () => void;
} {
  let active = true;
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    if (!active) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!active) return;
      active = false;
      timer = undefined;
      onTimeout();
    }, timeoutMs);
  };
  arm();
  return {
    onActivity: arm,
    stop: () => {
      if (!active) return;
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function abortedSignal(signal: AbortSignal): Promise<typeof ABORTED> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });
}

export async function runLlmAnalysis(input: LlmAnalysisRunInput): Promise<LlmAnalysisOutcome> {
  if (!input.enabled) {
    return { state: "disabled" };
  }
  const client = input.client;
  if (client === undefined) {
    return { state: "unavailable", reason: "no_client", cacheState: "not_attempted" };
  }

  if (
    input.provenance.semanticHash !== input.model.semanticHash ||
    input.provenance.semanticHash !== input.analysis.semanticHash
  ) {
    return { state: "unavailable", reason: "provenance_mismatch", cacheState: "not_attempted" };
  }

  const provenance: LlmAnalysisProvenance = {
    ...input.provenance,
    modelId: client.modelId,
    promptVersion: input.promptVersion,
  };

  const requestedModel =
    input.requestedModel ??
    (client.modelId ? { kind: "explicit", value: client.modelId } : { kind: "unresolved" });
  const requestedEffort = input.requestedEffort ?? { kind: "unresolved" };

  const contentHash = computeContentHash(input.input.slices, input.input.merge);
  const cacheKey: LlmFindingCacheKey = {
    specVersion: SEMANTIC_MODEL_SPEC_VERSION,
    model: requestedModel,
    effort: requestedEffort,
    semanticHash: provenance.semanticHash,
    inputVersion: input.input.version,
    promptVersion: input.promptVersion,
    outputLanguage: input.outputLanguage,
    contentHash,
  };

  const cached = input.cache.get(cacheKey);
  if (cached !== undefined) {
    const verified = verifyActionFindings({
      model: input.model,
      analysis: input.analysis,
      provenance: cached.provenance,
      aliases: input.input.aliases,
      facts: input.input.facts,
      findings: cached.findings,
    });
    return {
      state: "ready",
      cacheState: "hit",
      result: verified,
      schema: cached.schema,
      usage: { inputTokens: 0, outputTokens: 0 },
      models: cached.models,
      slices: cached.slices,
      analysisRunId: cached.analysisRunId,
      aliases: input.input.aliases,
      facts: input.input.facts,
    };
  }

  const slices = input.input.slices;
  const sliceCalls = Math.min(slices.length, LLM_MAX_CALLS);
  const plannedCalls =
    sliceCalls + (slices.length > 1 && input.input.merge && sliceCalls < LLM_MAX_CALLS ? 1 : 0);
  const perCallTimeoutMs = boundedTimeoutMs(
    input.perCallTimeoutMs,
    LLM_PER_CALL_TIMEOUT_MS,
    LLM_PER_CALL_TIMEOUT_MS
  );
  const startedAt = Date.now();
  let attemptedCalls = 0;
  let completedCalls = 0;
  let currentStage: LlmAnalysisCallStage = "slice";

  const notify = (
    event: LlmAnalysisProgress["event"],
    callIndex: number,
    sliceIndex: number
  ): void => {
    input.onProgress?.({
      event,
      stage: currentStage,
      callIndex,
      plannedCalls,
      maxCalls: LLM_MAX_CALLS,
      sliceIndex,
      sliceCount: slices.length,
      elapsedMs: Date.now() - startedAt,
    });
  };

  const runDiagnostics = (limit?: LlmAnalysisTimeoutLimit): LlmAnalysisRunDiagnostics => ({
    elapsedMs: Date.now() - startedAt,
    attemptedCalls,
    completedCalls,
    plannedCalls,
    maxCalls: LLM_MAX_CALLS,
    sliceCount: slices.length,
    stage: currentStage,
    ...(limit === undefined ? {} : { limit }),
  });

  const totalController = new AbortController();
  let totalTimedOut = false;
  const totalTimeoutMs = input.timeoutMs;
  const totalTimer =
    totalTimeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          totalTimedOut = true;
          totalController.abort();
        }, Number.isFinite(totalTimeoutMs) ? Math.max(0, totalTimeoutMs) : 0);

  const onOuterAbort = (): void => totalController.abort();
  input.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (input.signal?.aborted) totalController.abort();

  let aggregatedInputTokens = 0;
  let aggregatedOutputTokens = 0;
  let modelsObserved = false;
  const collectedModels = new Set<string>();

  const allCandidateFindings: ActionFinding[] = [];
  const allSchemaRejections: LlmFindingShapeRejection[] = [];
  const sliceVerificationResults: ActionFindingVerificationResult[] = [];
  let totalCandidatesCount = 0;

  try {
    const sliceAcceptedFindings: ActionFinding[][] = [];

    let callCount = 0;

    for (let sIdx = 0; sIdx < slices.length; sIdx++) {
      if (totalController.signal.aborted) {
        return {
          state: "unavailable",
          reason: totalTimedOut ? "client_timeout" : "client_aborted",
          cacheState: "miss",
          run: runDiagnostics(totalTimedOut ? "total" : undefined),
        };
      }
      if (callCount >= LLM_MAX_CALLS) break;
      callCount++;
      attemptedCalls++;
      notify("call_started", callCount, sIdx + 1);

      const slice = slices[sIdx];
      const callController = new AbortController();
      let callTimedOut = false;
      const watchdog = createInactivityWatchdog(perCallTimeoutMs, () => {
        callTimedOut = true;
        callController.abort();
      });

      const onParentAbort = () => callController.abort();
      totalController.signal.addEventListener("abort", onParentAbort, { once: true });

      let rawResult: LlmAnalysisGenerateResult | undefined;
      try {
        const generation = client.generate({
          promptVersion: input.promptVersion,
          outputLanguage: input.outputLanguage,
          modelId: client.modelId,
          prompt: slice.text,
          signal: callController.signal,
          onActivity: watchdog.onActivity,
        });

        const settled = await Promise.race([
          generation.then(
            (val) => ({ ok: true as const, value: val }),
            (err) => ({ ok: false as const, error: err })
          ),
          abortedSignal(callController.signal),
        ]);

        if (settled === ABORTED) {
          // 総時間切れは onParentAbort 経由でこの呼び出しも落とすので callTimedOut は偽のまま。
          // 先に立った側が「どちらの上限で落ちたか」になる
          return {
            state: "unavailable",
            reason: callTimedOut || totalTimedOut ? "client_timeout" : "client_aborted",
            cacheState: "miss",
            run: runDiagnostics(
              callTimedOut ? "per_call" : totalTimedOut ? "total" : undefined
            ),
          };
        }
        if (!settled.ok) {
          return {
            state: "unavailable",
            reason: "client_error",
            cacheState: "miss",
            run: runDiagnostics(),
          };
        }
        rawResult = settled.value;
        completedCalls++;
        notify("call_finished", callCount, sIdx + 1);
      } finally {
        watchdog.stop();
        totalController.signal.removeEventListener("abort", onParentAbort);
      }

      if (rawResult?.usage) {
        aggregatedInputTokens += rawResult.usage.inputTokens;
        aggregatedOutputTokens += rawResult.usage.outputTokens;
      }
      if (Array.isArray(rawResult?.models)) {
        modelsObserved = true;
        for (const m of rawResult.models) collectedModels.add(m);
      }

      const parsed = parseActionFindings(rawResult?.output);
      if (parsed.state === "malformed") {
        return {
          state: "unavailable",
          reason: "malformed_response",
          cacheState: "miss",
          run: runDiagnostics(),
        };
      }
      totalCandidatesCount += parsed.candidateCount;
      allSchemaRejections.push(...parsed.rejections);

      // Verify slice findings
      const verified = verifyActionFindings({
        model: input.model,
        analysis: input.analysis,
        provenance,
        aliases: input.input.aliases,
        facts: input.input.facts,
        findings: parsed.findings,
      });

      sliceVerificationResults.push(verified);
      sliceAcceptedFindings.push(verified.accepted);
      allCandidateFindings.push(...parsed.findings);
    }

    let finalFindings: ActionFinding[] = [];
    const allSliceDiagnostics = sliceVerificationResults.flatMap((r) => r.diagnostics);
    let mergeDiagnostics: typeof allSliceDiagnostics = [];

    if (slices.length > 1 && input.input.merge) {
      currentStage = "merge";
      if (totalController.signal.aborted) {
        return {
          state: "unavailable",
          reason: totalTimedOut ? "client_timeout" : "client_aborted",
          cacheState: "miss",
          run: runDiagnostics(totalTimedOut ? "total" : undefined),
        };
      }

      if (callCount >= LLM_MAX_CALLS) {
        return {
          state: "unavailable",
          reason: "client_error",
          cacheState: "miss",
          run: runDiagnostics(),
        };
      }
      const acceptedFromAllSlices = sliceAcceptedFindings.flat();
      const citedIds = new Set<string>();
      for (const finding of acceptedFromAllSlices) {
        for (const eid of finding.evidenceIds) citedIds.add(eid);
        for (const fid of finding.impact.calculation.factIds) citedIds.add(fid);
      }
      // Merge only needs the facts supporting accepted findings, including dependent evidence.
      // Keep the full fact table for final verification below.
      const mergeFacts = new Map<string, NonNullable<ReturnType<NumericFactTable["get"]>>>();
      for (const id of citedIds) {
        const alias = input.input.aliases.aliasOf.get(id) ?? id;
        const fact = input.input.facts.get(alias);
        if (fact === undefined || mergeFacts.has(alias)) continue;
        mergeFacts.set(alias, fact);
        citedIds.add(alias);
        for (const evidence of fact.evidenceIds) citedIds.add(evidence);
      }
      const mergeFactsText = renderFactsSection(mergeFacts);
      const acceptedJson = JSON.stringify(acceptedFromAllSlices);
      const citedExcerpts = renderCitedExcerpts(input.input.aliases, citedIds, input.input.items);
      let mergePromptText = [
        input.input.merge.text,
        mergeFactsText,
        "## 参照イベント抜粋（引用された行のみ）",
        citedExcerpts,
        "## 各スライスからの検証済み所見",
        acceptedJson,
      ].join("\n\n");

      const mergeBudgetTokens = LLM_INPUT_BUDGET_TOKENS - LLM_RESERVED_TOKENS;
      if (estTokens(mergePromptText) > mergeBudgetTokens) {
        const shortExcerpts = renderCitedExcerpts(
          input.input.aliases,
          citedIds,
          input.input.items.map((i) => ({ ...i, line: i.line.slice(0, 60) }))
        );
        mergePromptText = [
          input.input.merge.text,
          mergeFactsText,
          "## 参照イベント抜粋（引用された行のみ・短縮）",
          shortExcerpts,
          "## 各スライスからの検証済み所見",
          acceptedJson,
        ].join("\n\n");

        if (estTokens(mergePromptText) > mergeBudgetTokens) {
          return {
            state: "unavailable",
            reason: "prompt_render_error",
            cacheState: "miss",
            run: {
              ...runDiagnostics(),
              mergeInputBudget: {
                estimatedTokens: estTokens(mergePromptText),
                budgetTokens: mergeBudgetTokens,
                templateTokens: estTokens(input.input.merge.text),
                factsTokens: estTokens(mergeFactsText),
                findingsTokens: estTokens(acceptedJson),
                excerptsTokens: estTokens(shortExcerpts),
              },
            },
          };
        }
      }

      callCount++;
      attemptedCalls++;
      notify("call_started", callCount, slices.length);
      const mergeCallController = new AbortController();
      let mergeCallTimedOut = false;
      const watchdog = createInactivityWatchdog(perCallTimeoutMs, () => {
        mergeCallTimedOut = true;
        mergeCallController.abort();
      });

      const onParentAbort = () => mergeCallController.abort();
      totalController.signal.addEventListener("abort", onParentAbort, { once: true });

      let mergeRawResult: LlmAnalysisGenerateResult | undefined;
      try {
        const generation = client.generate({
          promptVersion: input.promptVersion,
          outputLanguage: input.outputLanguage,
          modelId: client.modelId,
          prompt: mergePromptText,
          signal: mergeCallController.signal,
          onActivity: watchdog.onActivity,
        });

        const settled = await Promise.race([
          generation.then(
            (val) => ({ ok: true as const, value: val }),
            (err) => ({ ok: false as const, error: err })
          ),
          abortedSignal(mergeCallController.signal),
        ]);

        if (settled === ABORTED) {
          return {
            state: "unavailable",
            reason: mergeCallTimedOut || totalTimedOut ? "client_timeout" : "client_aborted",
            cacheState: "miss",
            run: runDiagnostics(
              mergeCallTimedOut ? "per_call" : totalTimedOut ? "total" : undefined
            ),
          };
        }
        if (!settled.ok) {
          return {
            state: "unavailable",
            reason: "client_error",
            cacheState: "miss",
            run: runDiagnostics(),
          };
        }
        mergeRawResult = settled.value;
        completedCalls++;
        notify("call_finished", callCount, slices.length);
      } finally {
        watchdog.stop();
        totalController.signal.removeEventListener("abort", onParentAbort);
      }

      if (mergeRawResult?.usage) {
        aggregatedInputTokens += mergeRawResult.usage.inputTokens;
        aggregatedOutputTokens += mergeRawResult.usage.outputTokens;
      }
      if (Array.isArray(mergeRawResult?.models)) {
        modelsObserved = true;
        for (const m of mergeRawResult.models) collectedModels.add(m);
      }

      const mergeParsed = parseActionFindings(mergeRawResult?.output);
      if (mergeParsed.state === "malformed") {
        return {
          state: "unavailable",
          reason: "malformed_response",
          cacheState: "miss",
          run: runDiagnostics(),
        };
      }
      totalCandidatesCount += mergeParsed.candidateCount;
      allSchemaRejections.push(...mergeParsed.rejections);
      finalFindings = mergeParsed.findings;

      const mergeVerified = verifyActionFindings({
        model: input.model,
        analysis: input.analysis,
        provenance,
        aliases: input.input.aliases,
        facts: input.input.facts,
        findings: finalFindings,
      });
      mergeDiagnostics = mergeVerified.diagnostics;
    } else {
      finalFindings = allCandidateFindings;
    }

    const verifiedResult = verifyActionFindings({
      model: input.model,
      analysis: input.analysis,
      provenance,
      aliases: input.input.aliases,
      facts: input.input.facts,
      findings: finalFindings,
    });

    const totalVerifiedCount = totalCandidatesCount - allSchemaRejections.length;
    const combinedDiagnostics =
      slices.length > 1
        ? [...allSliceDiagnostics, ...mergeDiagnostics]
        : verifiedResult.diagnostics;
    const combinedByReason: Record<string, number> = {};
    for (const d of combinedDiagnostics) {
      for (const r of d.rejections) {
        combinedByReason[r.reason] = (combinedByReason[r.reason] ?? 0) + 1;
      }
    }

    const finalVerifiedResult: ActionFindingVerificationResult = {
      specVersion: verifiedResult.specVersion,
      provenance,
      accepted: verifiedResult.accepted,
      diagnostics: combinedDiagnostics,
      counts: {
        total: totalVerifiedCount,
        accepted: verifiedResult.accepted.length,
        rejected: combinedDiagnostics.length,
        byReason: combinedByReason,
      },
    };

    const schemaDiag = schemaDiagnosticsOf(
      totalCandidatesCount,
      totalVerifiedCount,
      allSchemaRejections
    );

    const analysisRunId = createHash("sha256")
      .update(llmFindingCacheKeyString(cacheKey) + String(provenance.analysisGeneratedAt), "utf8")
      .digest("hex")
      .slice(0, 16);

    const finalModels: string[] | null = modelsObserved ? [...collectedModels] : null;

    const cacheEntry: LlmFindingCacheEntry = {
      findings: finalFindings,
      schema: schemaDiag,
      provenance,
      usage: { inputTokens: aggregatedInputTokens, outputTokens: aggregatedOutputTokens },
      models: finalModels,
      slices: slices.length,
      analysisRunId,
    };
    input.cache.set(cacheKey, cacheEntry);

    return {
      state: "ready",
      cacheState: "miss",
      result: finalVerifiedResult,
      schema: schemaDiag,
      usage: { inputTokens: aggregatedInputTokens, outputTokens: aggregatedOutputTokens },
      models: finalModels,
      slices: slices.length,
      analysisRunId,
      aliases: input.input.aliases,
      facts: input.input.facts,
    };
  } finally {
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    input.signal?.removeEventListener("abort", onOuterAbort);
  }
}
