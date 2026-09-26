import * as l10n from "@vscode/l10n";
import type { L3ReportPayload, NormalizedEventBody, SemanticModelPayload } from "./protocol";
import type { SemanticModel } from "./semantic-model";
import { buildCitationAliasTable } from "./llm-citation-alias";
import type { CitationAliasTable } from "./llm-citation-alias";
import { redactAbsolutePaths } from "./path-redaction";
import { renderReferenceEnvelope } from "./llm-context-files";
import type { ContextFile } from "./llm-context-files";

export const LLM_INPUT_BUDGET_TOKENS = 180_000;
export const LLM_RESERVED_TOKENS = 30_000;
export const MIN_SLICE_EVENT_BUDGET_TOKENS = 20_000;
export const LLM_MAX_SLICES = 6;
export const LLM_MAX_CALLS = 7;
export const LLM_PER_CALL_TIMEOUT_MS = 300_000;
export const LLM_INPUT_VERSION = "w-input-2";

export interface GuardrailSignalSummary {
  id: string;
  kind: string;
  subjectId: string;
  firstAt: number;
  lastAt: number;
  count: number;
}

// 入力は本文と時刻だけを読む。JSONL 読み直し（HistoryEvent）は封筒を持たないので NormalizedEvent を要求しない
export type LlmAnalysisInputEvent = NormalizedEventBody & { timestamp: number };

export interface LlmAnalysisInputContext {
  events: readonly LlmAnalysisInputEvent[];
  model?: SemanticModel | SemanticModelPayload;
  l3: L3ReportPayload;
  guardrailSignals: GuardrailSignalSummary[];
  contextFiles: ContextFile[];
  // true = events は Host が保持する直近分だけで、セッション先頭を含まない（JSONL を読めなかった代用）
  sessionHeadMissing?: boolean;
  // transcript 層で欠けた分。省略 = 欠落を観測していない。窓落ちと予算切りだけを申告すると、
  // 欠けた母集合の上で「検証を通った」と名乗る（R-DSP-01）
  transcriptGaps?: TranscriptGapSummary;
}

export interface TranscriptGapSummary {
  unreadableAgentCount?: number;
  omittedTranscriptCount?: number;
  hierarchyIncomplete?: true;
  historyReadFailed?: true;
  historyMalformedLineCount?: number;
  evidenceFoldErrorCount?: number;
}

// 欠落の注記。プロンプトの被覆行と分析ビューの入力行の両方に同じ文で出す。undefined = 欠落なし
export function formatTranscriptGapNote(gaps: TranscriptGapSummary | undefined): string | undefined {
  if (gaps === undefined) return undefined;
  const parts: string[] = [];
  if (gaps.unreadableAgentCount !== undefined) {
    parts.push(l10n.t("{0} subagent records could not be read and are not in the input", gaps.unreadableAgentCount));
  }
  if (gaps.omittedTranscriptCount !== undefined) {
    parts.push(l10n.t("{0} subagent records were not read because of the limit and are not in the input", gaps.omittedTranscriptCount));
  }
  if (gaps.hierarchyIncomplete) parts.push(l10n.t("The subagent list could not be read completely"));
  if (gaps.historyReadFailed) parts.push(l10n.t("Reading the record failed partway through; nothing after that point is in the input"));
  if (gaps.historyMalformedLineCount !== undefined) {
    parts.push(l10n.t("{0} lines of the record are malformed and are not in the input", gaps.historyMalformedLineCount));
  }
  if (gaps.evidenceFoldErrorCount !== undefined) {
    parts.push(l10n.t("{0} events are not in the evidence index and are not in the fact table", gaps.evidenceFoldErrorCount));
  }
  return parts.length > 0 ? parts.join(l10n.t("; ")) : undefined;
}

export interface NumericFactItem {
  id: string;
  unit: "ms" | "count";
  value: number;
  evidenceIds: string[];
  label?: string;
  toolName?: string;
  isError?: boolean;
  kind?: string;
  subject?: string;
  path?: string;
}

export type NumericFactTable = ReadonlyMap<string, NumericFactItem>;

export interface EventItem {
  canonicalId: string;
  alias: string;
  timestamp: number;
  line: string;
  isError: boolean;
  toolName?: string;
  inputSummary?: string;
  resultPreview?: string;
  durationMs?: number;
}

export interface LlmAnalysisInput {
  version: typeof LLM_INPUT_VERSION;
  aliases: CitationAliasTable;
  facts: NumericFactTable;
  slices: { text: string; estTokens: number }[];
  merge?: { text: string };
  stats: {
    events: number;
    sessionEvents: number;
    estTokens: number;
    slices: number;
    bodyLimit: number;
    droppedEvents?: number;
    sessionHeadMissing?: true;
    transcriptGaps?: TranscriptGapSummary;
    contextFilesInSlices: boolean;
  };
  items: readonly EventItem[];
}

// 分析ビューの入力被覆行。webview は文字列を置くだけ（VND-S6）
export function formatInputCoverageLabel(stats: LlmAnalysisInput["stats"]): string {
  const all = stats.events >= stats.sessionEvents;
  const gapNote = formatTranscriptGapNote(stats.transcriptGaps);
  // 「全件」は Host が読めた事象の全件であって、記録に欠落があればその外は含まない（R-DSP-01）
  const gapSuffix = gapNote === undefined ? "" : l10n.t(". Record gaps: {0}", gapNote);
  if (stats.sessionHeadMissing) {
    return all
      ? l10n.t("Input: the {0} most recent events because the record could not be read (session start not included){1}", stats.sessionEvents, gapSuffix)
      : l10n.t("Input: {1} of the {0} most recent events because the record could not be read (trimmed to budget; session start not included){2}", stats.sessionEvents, stats.events, gapSuffix);
  }
  return all
    ? l10n.t("Input: {0} session events (all){1}", stats.sessionEvents, gapSuffix)
    : l10n.t("Input: {1} of {0} session events (trimmed to budget){2}", stats.sessionEvents, stats.events, gapSuffix);
}

// 画面に出ていて独立検証できる指標だけを LLM の事実表（M:<key>）へ渡す。longGapMs / longGapCount /
// actualConcurrency / fileWriteConflictCount / resourceDependencyCount / observedConstraintChainMs は
// 状況タブに表示経路が無く独立検証もできないため渡さない（R-DSP-11、D-2）
export const METRIC_UNIT_MAP: Record<string, "ms" | "count"> = {
  failureCount: "count",
};

export const DIVERGENCE_KIND_UNIT: Record<string, "ms" | "count"> = {
  serialization: "ms",
  progress_stagnation: "ms",
  unsupported_completion: "count",
  declared_state_conflict: "count",
};

export function estTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 2);
}

function formatOffset(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `+${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

type ToolStartedEvent = Extract<LlmAnalysisInputEvent, { kind: "tool_call_started" }>;

function buildEventItems(
  events: readonly LlmAnalysisInputEvent[],
  firstTimestamp: number,
  bodySuccessCap: number,
  bodyFailCap: number,
  aliases: CitationAliasTable
): EventItem[] {
  const items: EventItem[] = [];

  const toolIdToAlias = new Map<string, string>();
  const toolStartedMap = new Map<string, ToolStartedEvent>();
  let eventSeq = 0;
  let userSeq = 0;

  for (const event of events) {
    if (event.kind === "assistant_text_delta" || event.kind === "replayed_message") {
      continue;
    }

    const offset = formatOffset(event.timestamp - firstTimestamp);

    if (event.kind === "user_message") {
      userSeq++;
      const messageId = event.turnId ?? `u_${userSeq}`;
      const alias = aliases.aliasOf.get(messageId) ?? `U${userSeq}`;
      // 人間の発話は正規化時に redact されない唯一の本文で、プロンプトは外へ出る。
      // cap より先に redact する（途中で切れた断片が redact 対象形を失うのを避ける）
      const userText = redactAbsolutePaths(event.text ?? "").slice(0, 300).replace(/\r?\n/g, " ");
      const line = `${alias} | ${offset} | user | ${userText}`;
      items.push({
        canonicalId: messageId,
        alias,
        timestamp: event.timestamp,
        line,
        isError: false,
      });
      continue;
    }

    if (event.kind === "tool_call_started") {
      eventSeq++;
      const alias = aliases.aliasOf.get(event.toolUseId) ?? `E${eventSeq}`;
      toolIdToAlias.set(event.toolUseId, alias);
      toolStartedMap.set(event.toolUseId, event);
      continue;
    }

    if (event.kind === "tool_call_finished") {
      const toolUseId = event.toolUseId;
      let alias = toolIdToAlias.get(toolUseId);
      if (!alias) {
        eventSeq++;
        alias = `E${eventSeq}`;
        toolIdToAlias.set(toolUseId, alias);
      }

      const started = toolStartedMap.get(toolUseId);
      const isError = event.isError;
      const durationMs = started ? Math.max(0, event.timestamp - started.timestamp) : 0;
      const durationSec = (durationMs / 1000).toFixed(1);
      const status = isError ? `fail ${durationSec}s` : `ok ${durationSec}s`;

      let parentStr = "root";
      if (started?.parentToolUseId) {
        const pAlias = toolIdToAlias.get(started.parentToolUseId) ?? started.parentToolUseId;
        parentStr = `a:${pAlias}`;
      }

      const toolName = started?.toolName ?? "Tool";
      let inputSummary = (started?.inputSummary ?? started?.inputPreview ?? "").replace(/\r?\n/g, " ");
      if (started?.delegation) {
        const parts: string[] = [];
        if (started.delegation.description) parts.push(`description="${started.delegation.description}"`);
        if (started.delegation.subagentType) parts.push(`subagentType="${started.delegation.subagentType}"`);
        if (started.delegation.subagentModel) parts.push(`subagentModel="${started.delegation.subagentModel}"`);
        if (started.delegation.isBackground !== undefined) parts.push(`isBackground=${started.delegation.isBackground}`);
        if (parts.length > 0) inputSummary = parts.join(" ");
      }

      const cap = isError ? bodyFailCap : bodySuccessCap;
      const rawPreview = (event.resultPreview ?? "").replace(/\r?\n/g, " ");
      const resultPreview = cap > 0 ? rawPreview.slice(0, cap) : "";

      const line = `${alias} | ${offset} | ${parentStr} | ${toolName} | ${inputSummary} | ${status} | ${resultPreview}`;
      items.push({
        canonicalId: toolUseId,
        alias,
        timestamp: event.timestamp,
        line,
        isError,
        toolName,
        inputSummary,
        resultPreview,
        durationMs,
      });
    }
  }

  return items;
}

function buildGlobalAliases(context: LlmAnalysisInputContext): CitationAliasTable {
  const events: { toolUseId: string }[] = [];
  const userMessages: { messageId: string }[] = [];
  const metrics: { metricId: string }[] = [];
  const divergenceRecords: { divergenceId: string }[] = [];
  const guardrailSignals: { signalId: string }[] = [];
  const contextFiles: { fileId: string }[] = [];

  let userCount = 0;
  for (const event of context.events) {
    if (event.kind === "user_message") {
      userCount++;
      const id = event.turnId ?? `u_${userCount}`;
      userMessages.push({ messageId: id });
    } else if (event.kind === "tool_call_finished") {
      // L-6: Only mint E aliases for events that produce rendered lines
      if (event.toolUseId && !events.some((e) => e.toolUseId === event.toolUseId)) {
        events.push({ toolUseId: event.toolUseId });
      }
    }
  }

  // M-5: Only mint M: aliases for metrics in METRIC_UNIT_MAP
  if (context.l3?.analysis?.metrics) {
    for (const key of Object.keys(context.l3.analysis.metrics)) {
      if (METRIC_UNIT_MAP[key] !== undefined) {
        metrics.push({ metricId: `M:${key}` });
      }
    }
  }

  if (context.l3?.divergences?.kinds) {
    for (const kind of Object.values(context.l3.divergences.kinds)) {
      for (const rec of kind.records) {
        if (rec.divergenceId && !divergenceRecords.some((d) => d.divergenceId === rec.divergenceId)) {
          divergenceRecords.push({ divergenceId: rec.divergenceId });
        }
      }
    }
  }

  for (const sig of context.guardrailSignals) {
    if (sig.id && !guardrailSignals.some((g) => g.signalId === sig.id)) {
      guardrailSignals.push({ signalId: sig.id });
    }
  }

  for (const f of context.contextFiles) {
    if (f.id && !contextFiles.some((cf) => cf.fileId === f.id)) {
      contextFiles.push({ fileId: f.id });
    }
  }

  return buildCitationAliasTable({
    events,
    userMessages,
    metrics,
    divergenceRecords,
    guardrailSignals,
    contextFiles,
  });
}

export function buildNumericFactTable(
  context: LlmAnalysisInputContext,
  aliases: CitationAliasTable
): NumericFactTable {
  const facts = new Map<string, NumericFactItem>();

  const startedMap = new Map<string, ToolStartedEvent>();
  for (const event of context.events) {
    if (event.kind === "tool_call_started") {
      startedMap.set(event.toolUseId, event);
    }
  }

  // 1. Tool events: duration in ms
  let eventSeq = 0;
  // W（回避可能なコスト）が根拠として引く E の別名。toolUseId からは引けない
  // （aliasOf に無いときは連番へ落ちるため、ここで確定した別名を持ち回る）
  const eventAliasOf = new Map<string, string>();
  for (const event of context.events) {
    if (event.kind === "tool_call_finished") {
      eventSeq++;
      const alias = aliases.aliasOf.get(event.toolUseId) ?? `E${eventSeq}`;
      eventAliasOf.set(event.toolUseId, alias);
      const started = startedMap.get(event.toolUseId);
      const durationMs = started ? Math.max(0, event.timestamp - started.timestamp) : 0;
      facts.set(alias, {
        id: alias,
        unit: "ms",
        value: durationMs,
        evidenceIds: [event.toolUseId],
        toolName: started?.toolName ?? "Tool",
        isError: event.isError,
      });
    }
  }

  // 2. User messages: count = 1
  let userSeq = 0;
  for (const event of context.events) {
    if (event.kind === "user_message") {
      userSeq++;
      const id = event.turnId ?? `u_${userSeq}`;
      const alias = aliases.aliasOf.get(id) ?? `U${userSeq}`;
      facts.set(alias, {
        id: alias,
        unit: "count",
        value: 1,
        evidenceIds: [id],
        label: id,
      });
    }
  }

  // 3. Metrics from L3 (L-4 & M-5)
  if (context.l3?.analysis?.metrics) {
    for (const [key, metric] of Object.entries(context.l3.analysis.metrics)) {
      const unit = METRIC_UNIT_MAP[key];
      // typeof は NaN / Infinity を number として通す。通すとプロンプトへ value=NaN が出る
      if (
        unit !== undefined &&
        metric &&
        metric.state === "observed" &&
        typeof metric.value === "number" &&
        Number.isFinite(metric.value)
      ) {
        const id = `M:${key}`;
        facts.set(id, {
          id,
          unit,
          value: metric.value,
          evidenceIds: metric.basis?.nodeIds ?? [],
          label: key,
        });
      }
    }
  }

  // 4. Divergences (L-4 & M-6)
  if (context.l3?.divergences?.kinds) {
    let divSeq = 0;
    for (const [k, kind] of Object.entries(context.l3.divergences.kinds)) {
      // M（指標）と同じ判定。undetermined は「判定できなかった」であって観測ではない。
      // l3-divergence.ts は undetermined のとき records を空で返すが、その不変条件は
      // 型にも protocol のガードにも無いので、事実表の側で見る
      if (kind.state !== "observed") continue;
      for (const rec of kind.records) {
        // magnitude に書き手がいないので既定値を置かない。置くと unit=ms の kind で
        // 「1 ミリ秒」という測っていない値が事実表に載り R-DSP-11 に反する。
        // typeof は NaN / Infinity を number として通すので有限性まで見る
        if (typeof rec.magnitude !== "number" || !Number.isFinite(rec.magnitude)) continue;
        divSeq++;
        const alias = aliases.aliasOf.get(rec.divergenceId) ?? `D${divSeq}`;
        const magnitude = rec.magnitude;
        const dKind = rec.kind ?? k;
        const unit = DIVERGENCE_KIND_UNIT[dKind] ?? "count";
        const subject = rec.subjectIds?.join(", ");
        facts.set(alias, {
          id: alias,
          unit,
          value: magnitude,
          evidenceIds: rec.subjectIds ?? [],
          kind: dKind,
          subject,
          label: rec.divergenceId,
        });
      }
    }
  }

  // 5. Guardrail signals (M-6)
  let gSeq = 0;
  for (const sig of context.guardrailSignals) {
    gSeq++;
    const alias = aliases.aliasOf.get(sig.id) ?? `G${gSeq}`;
    facts.set(alias, {
      id: alias,
      unit: "count",
      value: sig.count,
      evidenceIds: [sig.id],
      kind: sig.kind,
      subject: sig.subjectId,
      label: sig.kind,
    });
  }

  // 6. 回避可能なコスト（W）。**対処すれば消えることが計算の定義から保証される時間だけ**を載せる。
  // E（所要時間）を impact に使うと「成功した処理にかかった時間」が影響として報告される
  // （R-DSP-01）。
  // 事実に「無駄」が無い限りプロンプトをどう書いても直らないので、ここで引き算した値を作る。
  //
  // `discarded_attempt`: 失敗した呼び出しの所要時間。失敗そのものが無駄なので全額。
  // 重複（同じ操作の 2 回目以降）は判定キーの実測待ちで未実装。
  let wasteSeq = 0;
  for (const event of context.events) {
    if (event.kind !== "tool_call_finished" || event.isError !== true) continue;
    const started = startedMap.get(event.toolUseId);
    const eAlias = eventAliasOf.get(event.toolUseId);
    if (started === undefined || eAlias === undefined) continue;
    wasteSeq++;
    const alias = `W${wasteSeq}`;
    facts.set(alias, {
      id: alias,
      unit: "ms",
      value: Math.max(0, event.timestamp - started.timestamp),
      // E の別名を持つ（toolUseId ではない）。renderSliceFacts がスライス判定に使う
      evidenceIds: [eAlias],
      kind: "discarded_attempt",
      toolName: started.toolName,
    });
  }

  return facts;
}

export function renderFactsSection(facts: NumericFactTable): string {
  const lines: string[] = ["## 数値事実一覧（Numeric Facts: calculation で引用可能）\n"];
  for (const [id, fact] of facts) {
    let extra = "";
    if (fact.kind) {
      extra += ` | kind=${fact.kind}`;
    }
    if (fact.subject) {
      extra += ` | subject=${fact.subject}`;
    }
    lines.push(`- ${id} | unit=${fact.unit} | value=${fact.value}${extra}`);
  }
  return lines.join("\n");
}

export function renderSliceFacts(facts: NumericFactTable, sliceItems: readonly EventItem[]): string {
  const lines: string[] = ["## 数値事実一覧（Numeric Facts: calculation で引用可能）\n"];
  const sliceAliasSet = new Set(sliceItems.map((i) => i.alias));
  for (const [id, fact] of facts) {
    if (id.startsWith("E") || id.startsWith("U")) {
      if (!sliceAliasSet.has(id)) continue;
    }
    // W は根拠の E がこのスライスに無いと引用しても検算できない（LLM はスライスしか見ない）
    if (id.startsWith("W")) {
      if (!fact.evidenceIds.some((e) => sliceAliasSet.has(e))) continue;
    }
    let extra = "";
    if (fact.kind) {
      extra += ` | kind=${fact.kind}`;
    }
    if (fact.subject) {
      extra += ` | subject=${fact.subject}`;
    }
    lines.push(`- ${id} | unit=${fact.unit} | value=${fact.value}${extra}`);
  }
  return lines.join("\n");
}

function renderContextFilesSection(contextFiles: ContextFile[]): string {
  if (contextFiles.length === 0) return "";
  const lines: string[] = ["## 参照ファイル（非信頼データ）\n"];
  for (const file of contextFiles) {
    lines.push(renderReferenceEnvelope(file));
  }
  return lines.join("\n\n");
}

export function renderCitedExcerpts(
  _aliases: CitationAliasTable,
  citedIds: Iterable<string>,
  items: readonly EventItem[]
): string {
  const citedSet = new Set(citedIds);
  const matchingItems = items.filter(
    (item) => citedSet.has(item.alias) || citedSet.has(item.canonicalId)
  );
  if (matchingItems.length === 0) {
    return "(引用されたイベントはありません)";
  }
  return matchingItems
    .map((i) => (i.line.length > 120 ? i.line.slice(0, 120) + "…" : i.line))
    .join("\n");
}

export function buildLlmAnalysisInput(context: LlmAnalysisInputContext): LlmAnalysisInput {
  const aliases = buildGlobalAliases(context);
  const facts = buildNumericFactTable(context, aliases);

  const firstTimestamp =
    context.events.length > 0 ? context.events[0].timestamp : 0;

  const factsText = renderFactsSection(facts);
  const filesText = renderContextFilesSection(context.contextFiles);
  let contextFilesInSlices = true;
  let currentFilesText = filesText;
  let commonPrefix = `${factsText}\n\n${currentFilesText ? currentFilesText + "\n\n" : ""}`;

  const budgetTokens = LLM_INPUT_BUDGET_TOKENS - LLM_RESERVED_TOKENS;

  // Body cap configs:
  const bodyConfigs = [
    { success: 200, fail: 800 },
    { success: 60, fail: 800 },
    { success: 0, fail: 300 },
    { success: 0, fail: 0 },
  ];

  let selectedConfigIdx = 0;
  let selectedConfig = bodyConfigs[0];
  let items = buildEventItems(context.events, firstTimestamp, selectedConfig.success, selectedConfig.fail, aliases);
  const totalEventsCount = items.length;

  const headNote = context.sessionHeadMissing ? "記録が読めないため Host が保持する直近分のみ。セッション先頭を含まない" : "セッション全件";
  // transcript 層の欠落も被覆行に載せる。無いときは「なし」と明示し、書き忘れと区別する（R-DSP-03）
  const gapNote = formatTranscriptGapNote(context.transcriptGaps) ?? "なし";
  const coverageString = (range: string, dropped: number) =>
    `(カバレッジ: セッション事象 ${totalEventsCount} 件中 ${totalEventsCount - dropped} 件を入力${dropped > 0 ? "（予算で絞った）" : ""}, 当該スライス範囲 ${range} 件, 入力元: ${headNote}, 記録の欠落: ${gapNote}, contextFilesInSlices: ${contextFilesInSlices}, droppedEvents: ${dropped} 件)`;

  let allEventsText = items.map((i) => i.line).join("\n");
  let fullPrompt = `${commonPrefix}## 実行イベント列\n${coverageString(`1..${items.length}`, 0)}\n\n${allEventsText}`;
  let tokens = estTokens(fullPrompt);

  if (tokens > budgetTokens) {
    selectedConfigIdx = 1;
    selectedConfig = bodyConfigs[1];
    items = buildEventItems(context.events, firstTimestamp, selectedConfig.success, selectedConfig.fail, aliases);
    allEventsText = items.map((i) => i.line).join("\n");
    fullPrompt = `${commonPrefix}## 実行イベント列\n${coverageString(`1..${items.length}`, 0)}\n\n${allEventsText}`;
    tokens = estTokens(fullPrompt);
  }

  if (tokens > budgetTokens) {
    selectedConfigIdx = 2;
    selectedConfig = bodyConfigs[2];
    items = buildEventItems(context.events, firstTimestamp, selectedConfig.success, selectedConfig.fail, aliases);
    allEventsText = items.map((i) => i.line).join("\n");
    fullPrompt = `${commonPrefix}## 実行イベント列\n${coverageString(`1..${items.length}`, 0)}\n\n${allEventsText}`;
    tokens = estTokens(fullPrompt);
  }

  let slices: { text: string; estTokens: number }[] = [];
  let droppedEventsCount = 0;

  if (tokens <= budgetTokens) {
    slices.push({ text: fullPrompt, estTokens: tokens });
  } else {
    // Slicing needed — compute sliceBudget and degrade in documented order (H-2):
    let prefixTokens = estTokens(commonPrefix + "## 実行イベント列\n\n");
    let sliceBudget = budgetTokens - prefixTokens;

    // Step (i): Drop context files from slices if below MIN_SLICE_EVENT_BUDGET_TOKENS
    if (sliceBudget < MIN_SLICE_EVENT_BUDGET_TOKENS && contextFilesInSlices) {
      contextFilesInSlices = false;
      currentFilesText = "";
      commonPrefix = `${factsText}\n\n`;
      prefixTokens = estTokens(commonPrefix + "## 実行イベント列\n\n");
      sliceBudget = budgetTokens - prefixTokens;
    }

    // Step (ii): Drop body caps further if still below MIN_SLICE_EVENT_BUDGET_TOKENS
    while (sliceBudget < MIN_SLICE_EVENT_BUDGET_TOKENS && selectedConfigIdx < bodyConfigs.length - 1) {
      selectedConfigIdx++;
      selectedConfig = bodyConfigs[selectedConfigIdx];
      items = buildEventItems(context.events, firstTimestamp, selectedConfig.success, selectedConfig.fail, aliases);
      prefixTokens = estTokens(commonPrefix + "## 実行イベント列\n\n");
      sliceBudget = budgetTokens - prefixTokens;
    }

    if (sliceBudget < MIN_SLICE_EVENT_BUDGET_TOKENS) {
      sliceBudget = MIN_SLICE_EVENT_BUDGET_TOKENS;
    }

    // Greedy slicing
    const rawSlices: { items: EventItem[] }[] = [];
    let currentSliceItems: EventItem[] = [];
    let currentSliceTokens = 0;

    for (const item of items) {
      const itemTokens = estTokens(item.line + "\n");
      if (currentSliceTokens + itemTokens > sliceBudget && currentSliceItems.length > 0) {
        rawSlices.push({ items: currentSliceItems });
        currentSliceItems = [item];
        currentSliceTokens = itemTokens;
      } else {
        currentSliceItems.push(item);
        currentSliceTokens += itemTokens;
      }
    }
    if (currentSliceItems.length > 0) {
      rawSlices.push({ items: currentSliceItems });
    }

    // Step (iii): Drop oldest slices if exceeding LLM_MAX_SLICES
    let finalSlices = rawSlices;
    if (finalSlices.length > LLM_MAX_SLICES) {
      const toDropSlices = finalSlices.length - LLM_MAX_SLICES;
      const droppedSlicesList = finalSlices.slice(0, toDropSlices);
      droppedEventsCount = droppedSlicesList.reduce((acc, s) => acc + s.items.length, 0);
      finalSlices = finalSlices.slice(toDropSlices);
    }

    let runningEventIdx = droppedEventsCount;
    for (let idx = 0; idx < finalSlices.length; idx++) {
      const sliceItems = finalSlices[idx].items;
      const startIdx = runningEventIdx + 1;
      const endIdx = runningEventIdx + sliceItems.length;
      runningEventIdx = endIdx;

      const sliceFactsText = renderSliceFacts(facts, sliceItems);
      const slicePrefix = `${sliceFactsText}\n\n${contextFilesInSlices && currentFilesText ? currentFilesText + "\n\n" : ""}`;
      const covLine = coverageString(`${startIdx}..${endIdx}`, droppedEventsCount);
      const sliceEventsText = sliceItems.map((i) => i.line).join("\n");
      const sliceText = `${slicePrefix}## 実行イベント列\n${covLine}\n\n${sliceEventsText}`;
      slices.push({ text: sliceText, estTokens: estTokens(sliceText) });
    }
  }

  let mergePrompt: { text: string } | undefined = undefined;
  if (slices.length > 1) {
    mergePrompt = {
      text: [
        "## スライス統合指示",
        `セッションは合計 ${slices.length} スライスに分割されて分析されました。`,
        "各スライスで検証を通った所見一覧を以下に示します。重複する所見を統合・整理し、全体として最も重要な所見の JSON を出力してください。",
        "",
        ...(filesText ? ["", filesText] : []),
      ].join("\n\n"),
    };
  }

  const totalEstTokens = slices.reduce((acc, s) => acc + s.estTokens, 0);

  return {
    version: LLM_INPUT_VERSION,
    aliases,
    facts,
    slices,
    merge: mergePrompt,
    items,
    stats: {
      events: items.length - droppedEventsCount,
      sessionEvents: items.length,
      estTokens: totalEstTokens,
      slices: slices.length,
      bodyLimit: selectedConfig.success,
      ...(droppedEventsCount > 0 ? { droppedEvents: droppedEventsCount } : {}),
      ...(context.sessionHeadMissing ? { sessionHeadMissing: true as const } : {}),
      ...(context.transcriptGaps !== undefined ? { transcriptGaps: context.transcriptGaps } : {}),
      contextFilesInSlices,
    },
  };
}
