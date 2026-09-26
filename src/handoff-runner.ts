import { randomUUID } from "node:crypto";
import path from "node:path";
import * as l10n from "@vscode/l10n";
import type {
  HookCallback,
  SDKMessage,
  SDKUserMessage,
  forkSession as sdkForkSession,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import {
  acceptCompactSummary,
  COMPACT_INSTRUCTION,
  DECISIONS_PREAMBLE,
  ENVELOPE_PREAMBLE,
  extractDecisionLines,
  type ExtractedDecisionLine,
} from "./handoff-accept";
import {
  buildHandoffEnvelopeV2,
  parseHandoffEnvelope,
  type HandoffDecisionEntry,
  type HandoffDecisions,
  type HandoffEnvelopeV2,
  type HandoffUtterance,
} from "./handoff-envelope";
import {
  createParseYielder,
  createRecordUuidFilter,
  extractVerbatimUserUtterances,
  isHandoffGenerationBoundary,
} from "./session-transcript";
import { claudeProjectsDir } from "./claude-env";

export type ForkSessionFn = typeof sdkForkSession;
export type QueryFn = typeof sdkQuery;

// 記録として使えない行（JSON として読めない、または object でない）を数えて捨てる。数えずに捨てると、
// 破損行にあった発言が黙って欠けたまま「引き継ぎが完了しました」になる（R-HND-02）
export interface HandoffRecordsRead {
  records: Record<string, unknown>[];
  unreadableLineCount: number;
}

// 14MB 級の複製を 1 つの JS turn で parse すると拡張ホストがその間止まる。他の読取器と同じ
// 譲り方（createParseYielder）で分割する
export async function parseHandoffRecords(text: string): Promise<HandoffRecordsRead> {
  const accept = createRecordUuidFilter();
  const records: Record<string, unknown>[] = [];
  const maybeYield = createParseYielder();
  let unreadableLineCount = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const pendingYield = maybeYield();
    if (pendingYield) await pendingYield;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadableLineCount++;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      unreadableLineCount++;
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (!accept(record)) continue;
    records.push(record);
  }
  return { records, unreadableLineCount };
}

// 走査の失敗を「無い」へ潰さない（R-DSP-01）。潰すと、同期ロック・権限で確かめられなかっただけの
// 状態を「引き継ぎ先の会話が見つかりませんでした」と断言することになる。
// detail は表示へ出るので絶対パスを載せない（生の例外文は deps.log へ）
export type ForkFileLookup =
  | { path: string; reason?: null }
  | { path: null; reason: "not_found" | "scan_failed"; detail?: string };

export interface HandoffRunnerDeps {
  sdk: { forkSession: ForkSessionFn; query: QueryFn };
  cwd: string;
  claudeExecutablePath: string;
  env: NodeJS.ProcessEnv;
  lookupSessionFileById: (id: string) => Promise<ForkFileLookup>;
  readRecords: (filePath: string) => Promise<HandoffRecordsRead>;
  fs: { unlink(p: string): Promise<void>; readFile(p: string): Promise<string> };
  // 拒否した要約の生出力を残す口。fork は fail-closed で消すため、これが無いと判定規則を直す材料が残らない
  writeDiagnostic?: (name: string, text: string) => Promise<string>;
  persist: { get(k: string): unknown; update(k: string, v: unknown): Promise<void> };
  now: () => number;
  // 削除リトライの待ち（既定は実時計）。検査は間隔列を観測するために差し替える
  sleep?: (ms: number) => Promise<void>;
  timeoutMs: number;
  log: (line: string) => void;
  // 非終端の段階が変わるたびに呼ぶ（進行表示用）。終端（done / failed）では呼ばない
  onPhase?: (phase: HandoffPhase) => void;
  // compact 進行中の心拍（`status: compacting`、30 s 周期）ごとに呼ぶ。経過表示の入力
  onProgress?: (info: HandoffProgress) => void;
}

export interface HandoffProgress {
  phase: "compacting";
  heartbeats: number;
  // since が "result" なら result 到着から、"compact_start" なら compacting 段階への遷移からの経過。
  // 小さなセッションでは result より先に心拍が届く（実測 2026-09-06）ので、表示は since を見て
  // 「応答から」と「開始から」を分ける（R-DSP-01）
  elapsedMs: number;
  since: "compact_start" | "result";
}

export type HandoffFailReason =
  | "fork_failed"
  | "fork_path_unresolved"
  | "fork_path_scan_failed"
  | "verbatim_extract_failed"
  | "compact_timeout"
  | "compact_failed"
  | "hook_not_fired"
  | "compact_rejected_analysis"
  | "compact_rejected_structure"
  | "compact_rejected_length"
  | "envelope_append_failed"
  | "commit_failed"
  | "cancelled"
  | "source_busy"
  | "already_running";

export type HandoffOutcome =
  | {
      ok: true;
      runId: string;
      forkSessionId: string;
      forkFilePath: string;
      compact?: { preTokens: number; postTokens: number };
      // 成功時点の記録から取った状態カードの本文。F を読み直さない
      detail?: HandoffDetail;
      utteranceCount: number;
      // F のうち JSON として読めず捨てた行数。0 でなければ逐語が欠けている可能性を画面に出す（R-HND-02）
      unreadableLineCount: number;
    }
  | { ok: false; runId: string; reason: HandoffFailReason; detail?: string; forkSessionId?: string };

export type HandoffPhase =
  | "forking"
  | "extracting"
  | "compacting"
  | "accepting"
  | "appending"
  | "finishing"
  | "done"
  | "failed";

interface PersistedHandoff {
  runId: string;
  sourceSessionId: string;
  forkSessionId: string;
  filePath: string;
  phase: string;
  // 複数ウィンドウは globalState を共有してプロセスは別なので、稼働中の Runner を別プロセスから
  // 直接観測できない。この 2 つが起動時清掃に残る唯一の生存の手掛かり（AUDIT-05）
  owner: string;
  leaseUntil: number;
}

export const IN_FLIGHT_KEY = "laisora.handoffInFlight";
export const ORPHANS_KEY = "laisora.handoffOrphans";
const MAX_PERSISTED_HANDOFFS = 20;
const UNLINK_RETRY_DELAYS_MS = [100, 1_000, 3_000];
// CLI は `/compact` の `result: success` を compact が始まる前に返すことがある（実測 2026-09-06、CLI 2.1.261:
// result の 54 ms 後に `status: compacting` が始まり、PostCompact は result の 181 s 後）。
// 進行中は `status: compacting` が 30 s 周期で届く（実測）ので、この上限は
// 「心拍が何回連続で抜けたら compact が動いていないとみなすか」で読む。120 s = 4 回分。
// **心拍の周期より短くしないこと**（1 回の抜けで落ちる）。
// **`result` 到着後だけに効く別の猶予を足さないこと。** 心拍でしか引き直さない判定は、あらゆる stream
// メッセージで引き直す armTimeout がまだ生きていると見なす run を先に殺す（終端は先着が勝つ）
export const COMPACT_HEARTBEAT_GRACE_MS = 120_000;

// 別ウィンドウの起動時清掃が「この run はもう動いていない」と判断してよい無更新時間（AUDIT-05）。
// Runner が stream の信号ごとに引き直すので絶対時間の締め切りではない。
// **give-up 閾値（timeoutMs = COMPACT_HEARTBEAT_GRACE_MS）より長くすること。**
// 登録から最初の stream メッセージまでの窓（CLI 起動と resume を含む。armTimeout の注記のとおり未測定）は
// 初回の刻印だけが守っており、ここを詰めるとまだ諦めていない run の fork を別プロセスが消す
export const HANDOFF_LEASE_MS = COMPACT_HEARTBEAT_GRACE_MS * 2;

// 拡張ホストのプロセスごとに 1 つ。どのウィンドウが登録した run かはこれでしか分からない
const OWNER_ID = randomUUID();

// esbuild の define（extension バンドルのみ）。単体バンドルでは未定義なので typeof で守る
declare const __LAISORA_SDK_CLAUDE_CODE_VERSION__: string | undefined;
function expectedCliVersion(): string | undefined {
  return typeof __LAISORA_SDK_CLAUDE_CODE_VERSION__ === "string" ? __LAISORA_SDK_CLAUDE_CODE_VERSION__ : undefined;
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(value: SDKUserMessage): void {
    if (this.closed) throw new Error("input stream is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  private next(): Promise<IteratorResult<SDKUserMessage>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const item = await this.next();
      if (item.done) return;
      yield item.value;
    }
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textFromRecord(record: Record<string, unknown>): string {
  const content = asRecord(record.message)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const value = asRecord(block);
      return value?.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .join("");
}

function persistedEntries(value: unknown): PersistedHandoff[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PersistedHandoff => {
    const record = asRecord(entry);
    return (
      record !== undefined &&
      typeof record.runId === "string" &&
      typeof record.sourceSessionId === "string" &&
      typeof record.forkSessionId === "string" &&
      typeof record.filePath === "string" &&
      typeof record.phase === "string"
    );
  });
}

function isWithinProjects(filePath: string, projectsRoot: string): boolean {
  const relative = path.relative(path.resolve(projectsRoot), path.resolve(filePath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function lastCompactBoundaryIndex(records: readonly Record<string, unknown>[]): number {
  let lastBoundary = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i].type === "system" && records[i].subtype === "compact_boundary") lastBoundary = i;
  }
  return lastBoundary;
}

function compactSummariesAfter(
  records: readonly Record<string, unknown>[],
  lastBoundary: number
): Record<string, unknown>[] {
  return records.filter(
    (record, index) => index > lastBoundary && record.type === "user" && record.isCompactSummary === true
  );
}

// 4 条件の AND を真偽値で返すと「どれが崩れたか」が残らず再発時に診断できない。
// 満たしているときだけ undefined を返し、崩れた条件は観測値つきで名指しする
function forkIncompleteReason(
  records: readonly Record<string, unknown>[],
  forkSessionId: string
): string | undefined {
  const lastBoundary = lastCompactBoundaryIndex(records);
  if (lastBoundary < 0) return `no_boundary(records=${records.length})`;

  const summaries = compactSummariesAfter(records, lastBoundary);
  if (summaries.length !== 1) return `summary=${summaries.length}`;
  const accepted = acceptCompactSummary(textFromRecord(summaries[0]));
  if (!accepted.ok) return `summary_rejected=${accepted.reason ?? "unknown"}`;

  // 境界より後ろに絞る。引き継ぎで作られたセッションは自分の封筒を持っており、
  // それを再度引き継ぐと全域では 2 件以上になり、引き継ぎの連鎖が必ず失敗する。
  // 今回の run が足した封筒は compact 境界より後ろにしか存在しない
  const envelopes = records
    .filter((record, index) => index > lastBoundary && record.type === "user")
    .map((record) => parseHandoffEnvelope(textFromRecord(record)))
    .filter((parsed) => parsed.ok && parsed.version === "2");
  if (envelopes.length !== 1) return `envelope=${envelopes.length}`;
  const only = envelopes[0];
  if (!only.ok || only.version !== "2") return "envelope_unparsed";
  if (only.envelope.snapshot.forkSessionId !== forkSessionId) return "envelope_fork_mismatch";
  return undefined;
}

// 状態カードの展開部の本文。forkIncompleteReason と同じ規則で F の記録から拾う。
// 会話面の既存表示は compact 要約も封筒も非人間として捨てるので、ここで取り出さないと
// 利用者はどちらも読めない
export interface HandoffDetail {
  // 要約だけ取れない記録がある（封筒はあるが直前の要約が無い）。発言と決定行は封筒が持つので、
  // 要約の欠落で展開部ごと落とさない。画面は要約の欄にだけ「取得できません」を出す
  summary?: string;
  utterances: HandoffUtterance[];
  decisions?: HandoffDecisions;
}

// 拾うのは**封筒の直前**の要約（R-HND-10）。最新の compact 境界で選ぶと、引き継ぎの後に
// 自動 / 手動 compact が走った記録を再読込したとき別世代の要約が出るか取得に失敗する。
// live と復元で同じ関数を使う（引き継ぎ完了直後は封筒が最終レコードなので結果は変わらない）
export function extractHandoffDetail(
  records: readonly Record<string, unknown>[],
  forkSessionId: string
): HandoffDetail | undefined {
  let pendingSummary: string | undefined;
  let summary: string | undefined;
  let envelope: HandoffEnvelopeV2 | undefined;
  for (const record of records) {
    if (record.type === "user" && record.isCompactSummary === true) {
      pendingSummary = textFromRecord(record);
      continue;
    }
    if (!isHandoffGenerationBoundary(record, forkSessionId)) continue;
    const parsed = parseHandoffEnvelope(textFromRecord(record));
    if (!parsed.ok || parsed.version !== "2") continue;
    envelope = parsed.envelope;
    summary = pendingSummary;
  }
  if (envelope === undefined) return undefined;
  return {
    ...(summary !== undefined ? { summary } : {}),
    utterances: envelope.userUtterances,
    ...(envelope.decisions !== undefined ? { decisions: envelope.decisions } : {}),
  };
}

// 警報の閾値（R-HND-12）。**超過で新規の転記を止めたり古い行を落としたりしないこと**:
// 止めると言い換えで増えた古い重複が枠を占有し、最新の決定が落ちる＝この機能の目的と逆になる
export const DECISIONS_WARN_ENTRIES = 120;
export const DECISIONS_WARN_BYTES = 24_000;

// 世代をまたぐ重複排除のキー。**近似一致（prefix・編集距離）へ広げないこと**: 別の決定を
// 同一視する誤結合＝決定の取り違えになる
function decisionKey(tag: string, body: string): string {
  return `${tag}\0${body.replace(/\s+/g, " ").trim().replace(/\s*src=(?:user|assistant)$/i, "")}`;
}

function decisionIdNumber(id: string): number {
  const m = /^D(\d+)$/.exec(id);
  return m === null ? 0 : Number(m[1]);
}

export function mergeHandoffDecisions(
  previous: HandoffDecisions | undefined,
  lines: readonly ExtractedDecisionLine[],
  source: "hook" | "previous_only"
): HandoffDecisions {
  const carriedEntries = (previous?.entries ?? []).map((entry) => ({ ...entry }));
  const seen = [...carriedEntries, ...(previous?.removedLastGen ?? [])];
  const generation = seen.reduce((max, entry) => Math.max(max, entry.g), 0) + 1;
  // 採番は単調増加。removedLastGen は 1 世代で落ちるので、見えている id の最大値だけから
  // 決めると消した id が次々世代で別の決定へ再採番される（利用者が古い id を名指しすると
  // 別の決定が消える）。封筒が運ぶ nextId を優先し、欄が無い封筒でだけ最大値から復元する
  let nextId = Math.max(
    previous?.nextId ?? 0,
    seen.reduce((max, entry) => Math.max(max, decisionIdNumber(entry.id)), 0) + 1
  );
  // entries は carriedEntries そのもの。件数は追加より前に控える
  const carriedCount = carriedEntries.length;
  const entries = carriedEntries;
  const removedLastGen: HandoffDecisionEntry[] = [];
  let extracted = 0;
  let unknownIdRefs = 0;

  // 同じ id に [DONE] と [DROPPED] が並んだとき、行の順序で結果が変わらないようにする。
  // [DONE] を先に処理して勝たせ、その id を消せた [DROPPED] だけを取りこぼしから除く
  // （存在しない id を名指しした [DROPPED] は消せた結果ではないので従来どおり数える）
  const ordered = [...lines].sort((a, b) => Number(b.t === "DONE") - Number(a.t === "DONE"));
  const removedIds = new Set<string>();

  for (const line of ordered) {
    if (line.t === "DONE") {
      const at = line.id === undefined ? -1 : entries.findIndex((entry) => entry.id === line.id);
      // 存在しない ID を名指しした行は無視して数える。新規追加へ倒すと誤った決定が増える
      if (at < 0) {
        unknownIdRefs++;
        continue;
      }
      const gone = entries.splice(at, 1)[0];
      removedIds.add(gone.id);
      removedLastGen.push(gone);
      continue;
    }
    if (line.t === "DROPPED" && line.id !== undefined) {
      const target = entries.find((entry) => entry.id === line.id);
      if (target === undefined) {
        if (!removedIds.has(line.id)) unknownIdRefs++;
        continue;
      }
      // 消さない（DROPPED の記録が無いと恒久禁止に読まれる）
      target.t = "DROPPED";
      target.s = line.s;
      target.g = generation;
      continue;
    }
    const key = decisionKey(line.t, line.s);
    if (entries.some((entry) => decisionKey(entry.t, entry.s) === key)) continue;
    entries.push({ id: `D${nextId++}`, t: line.t, g: generation, s: line.s });
    extracted++;
  }

  // 警報の対象は恒久的に積む entries だけ。removedLastGen は 1 世代で落ちる一時の積み荷
  const bytes = jsonBytes({ preamble: DECISIONS_PREAMBLE, entries });
  const warn =
    entries.length >= DECISIONS_WARN_ENTRIES || bytes >= DECISIONS_WARN_BYTES
      ? { entries: entries.length, bytes }
      : undefined;

  return {
    preamble: DECISIONS_PREAMBLE,
    entries,
    ...(removedLastGen.length > 0 ? { removedLastGen } : {}),
    nextId,
    carried: carriedCount,
    extracted,
    removed: removedLastGen.length,
    unknownIdRefs,
    source,
    ...(warn !== undefined ? { warn } : {}),
  };
}

// 前世代の転記行。世代の切れ目は最後の v2 封筒（compact 境界ではない）
function previousDecisionsOf(
  records: readonly Record<string, unknown>[],
  log: (line: string) => void
): HandoffDecisions | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type !== "user") continue;
    const parsed = parseHandoffEnvelope(textFromRecord(records[i]));
    if (!parsed.ok || parsed.version !== "2") continue;
    // 落ちた decisions は次世代へ引き継がれない＝転記の連鎖がここで切れる。黙らせない
    if (parsed.decisionsDropped) log("handoff previous decisions dropped: envelope decisions failed validation");
    return parsed.envelope.decisions;
  }
  return undefined;
}

export const HANDOFF_DETAIL_MAX_BYTES = 200_000;

// `"summary":` と直後のカンマ。summary を載せた part の固定費
const SUMMARY_KEY_BYTES = 11;
// `"decisions":` と直後のカンマ
const DECISIONS_KEY_BYTES = 13;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export interface HandoffDetailPart {
  summary?: string;
  utterances: HandoffUtterance[];
  decisions?: HandoffDecisions;
}

// 展開部の分割（R-HND-02）。逐語は 1 件も切らない: 1 件だけで budget を超えるなら
// その 1 件だけの part にする（切り詰めると逐語性が崩れる）。summary は part 0 だけが運ぶ。
// budgetBytes は「メッセージ全体の上限 − 封筒（type/tabId/runId/part/total/utterances:[]）」を
// 呼び出し側が引いて渡す
export function buildHandoffDetailParts(
  summary: string | undefined,
  utterances: readonly HandoffUtterance[],
  budgetBytes: number,
  decisions?: HandoffDecisions
): HandoffDetailPart[] {
  const parts: HandoffDetailPart[] = [
    { ...(summary !== undefined ? { summary } : {}), utterances: [], ...(decisions !== undefined ? { decisions } : {}) },
  ];
  let used =
    (summary === undefined ? 0 : jsonBytes(summary) + SUMMARY_KEY_BYTES) +
    (decisions === undefined ? 0 : jsonBytes(decisions) + DECISIONS_KEY_BYTES);
  for (const utterance of utterances) {
    const current = parts[parts.length - 1];
    // 配列要素の実費は JSON 本体 ＋ 直前要素との区切り 1 バイト
    const cost = jsonBytes(utterance) + (current.utterances.length === 0 ? 0 : 1);
    // part を切れないのは「空の part」だけ。summary 付き part 0 の最初の逐語も
    // 予算を超えるなら次の part へ回す（summary との合計で上限を割らないため）
    const canSplit =
      current.utterances.length > 0 || current.summary !== undefined || current.decisions !== undefined;
    if (canSplit && used + cost > budgetBytes) {
      parts.push({ utterances: [utterance] });
      used = jsonBytes(utterance);
      continue;
    }
    current.utterances.push(utterance);
    used += cost;
  }
  return parts;
}

// 完了時にフォーカスを奪わない判定（R-HND-08）。開始時ではなく完了時の active タブで決める。
// vscode 非依存にして真理値表を検査できるようにしてある
export function shouldActivateForkTab(activeTabId: string | undefined, sourceTabId: string): boolean {
  return activeTabId !== undefined && activeTabId === sourceTabId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HandoffRunner {
  private readonly deps: HandoffRunnerDeps;
  private started = false;
  private phase: HandoffPhase = "forking";
  private terminal: HandoffFailReason | "done" | undefined;
  private terminalDetail: string | undefined;
  private abortController: AbortController | undefined;
  private inputQueue: InputQueue | undefined;

  constructor(deps: HandoffRunnerDeps) {
    this.deps = deps;
  }

  private transition(phase: HandoffPhase): void {
    if (this.terminal !== undefined) {
      this.deps.log(`handoff late phase ignored: ${phase}`);
      return;
    }
    this.phase = phase;
    this.deps.log(`handoff phase: ${phase}`);
    this.deps.onPhase?.(phase);
  }

  private commitTerminal(terminal: HandoffFailReason | "done", detail?: string): boolean {
    if (this.terminal !== undefined) {
      this.deps.log(`handoff late terminal ignored: ${terminal}; current=${this.terminal}`);
      return false;
    }
    this.terminal = terminal;
    this.terminalDetail = detail;
    this.phase = terminal === "done" ? "done" : "failed";
    this.deps.log(`handoff terminal: ${terminal}${detail === undefined ? "" : ` (${detail})`}`);
    return true;
  }

  cancel(): boolean {
    if (!this.started || !this.commitTerminal("cancelled")) return false;
    this.inputQueue?.close();
    this.abortController?.abort();
    // abort だけでは CLI が走っている compact を止めず、result まで流し切るまで run() が
    // 戻らない（2026-09-02 実機）。close() は CLI 子プロセスごと終了させる
    this.closeQuery();
    return true;
  }

  private query: { close?: () => void } | undefined;

  private closeQuery(): void {
    try {
      this.query?.close?.();
    } catch (error) {
      this.deps.log(`handoff query close failed: ${errorDetail(error)}`);
    }
  }

  async run(input: {
    sourceSessionId: string;
    sourceTitle: string;
    runId: string;
    sourceBusy: () => boolean;
  }): Promise<HandoffOutcome> {
    if (this.started) return { ok: false, runId: input.runId, reason: "already_running" };
    this.started = true;
    // R-HND-07: Host state, rather than webview button state, is authoritative.
    if (input.sourceBusy()) {
      this.commitTerminal("source_busy");
      return { ok: false, runId: input.runId, reason: "source_busy" };
    }

    let forkSessionId: string | undefined;
    let forkFilePath: string | undefined;
    let registryEntry: PersistedHandoff | undefined;
    let utteranceCount = 0;
    let unreadableLineCount = 0;
    let compact: { preTokens: number; postTokens: number } | undefined;
    let hookCount = 0;
    let envelopeCount = 0;
    // compact 完了の証拠。hook 単独に依存しない（stream の status / boundary でも先へ進む）
    let compactCompletedBy: "hook" | "status" | "boundary" | undefined;
    // hook が要約を受理したときだけ true。false なら commit 時に F の記録から同じ規則で受理する
    let acceptedByHook = false;
    let compactingHeartbeats = 0;
    let compactStartedAt: number | undefined;
    let resultAt: number | undefined;
    let lastHeartbeatAt: number | undefined;
    let cliVersion: string | undefined;
    let resultMessage: Record<string, unknown> | undefined;
    let drainStarted = false;
    let commitRecords: Record<string, unknown>[] | undefined;
    let detail: HandoffDetail | undefined;

    try {
      this.transition("forking");
      try {
        // dir を渡さない。dir は元記録の探索を projects/<符号化(dir)> に絞るので、起動 cwd の推定が
        // 外れていると元記録があっても not found になる。省くと全プロジェクトから id で探し、複製は
        // 元記録と同じディレクトリへ書かれる（SDK の forkSession の挙動）
        const fork = await this.deps.sdk.forkSession(input.sourceSessionId, {
          title: `⇢ ${input.sourceTitle}`,
        });
        forkSessionId = fork.sessionId;
      } catch (error) {
        this.commitTerminal("fork_failed", errorDetail(error));
      }

      if (forkSessionId !== undefined) {
        let lookup: ForkFileLookup | undefined;
        try {
          lookup = await this.deps.lookupSessionFileById(forkSessionId);
        } catch (error) {
          if (this.terminal === undefined) this.commitTerminal("fork_path_unresolved", errorDetail(error));
          else this.deps.log(`handoff cancelled fork path lookup failed: ${errorDetail(error)}`);
        }
        if (lookup?.path != null) forkFilePath = lookup.path;
        else if (lookup !== undefined && this.terminal === undefined) {
          if (lookup.reason === "scan_failed") {
            this.deps.log(`handoff fork path scan failed: ${lookup.detail ?? "(no detail)"}`);
            // 生の理由は Output だけへ（detail は画面に出るので保存先の絶対パスを載せない）
            this.commitTerminal("fork_path_scan_failed");
          } else {
            this.commitTerminal("fork_path_unresolved");
          }
        }
      }

      if (forkSessionId !== undefined && forkFilePath !== undefined) {
        registryEntry = {
          runId: input.runId,
          sourceSessionId: input.sourceSessionId,
          forkSessionId,
          filePath: forkFilePath,
          phase: "forking",
          owner: OWNER_ID,
          leaseUntil: this.deps.now() + HANDOFF_LEASE_MS,
        };
        await this.addRegistryEntry(IN_FLIGHT_KEY, registryEntry);

        if (this.terminal === undefined) {
          this.transition("extracting");
          try {
          const read = await this.deps.readRecords(forkFilePath);
          unreadableLineCount = read.unreadableLineCount;
          const utterances = extractVerbatimUserUtterances(read.records);
          utteranceCount = utterances.length;
          const previousDecisions = previousDecisionsOf(read.records, this.deps.log);

          if (this.terminal !== undefined) return this.failureOutcome(input.runId, forkSessionId);
          this.transition("compacting");
          compactStartedAt = this.deps.now();
          const queue = new InputQueue();
          this.inputQueue = queue;
          const abortController = new AbortController();
          this.abortController = abortController;
          queue.push({
            type: "user",
            message: { role: "user", content: `/compact ${COMPACT_INSTRUCTION.text}` },
            parent_tool_use_id: null,
            session_id: forkSessionId,
          });

          // abort だけでは CLI の compact が止まらず、子プロセスが F を掴んだまま unlink が失敗する。
          // ループ内の終端は全てここを通す
          const abortRun = (): void => {
            queue.close();
            abortController.abort();
            this.closeQuery();
          };
          const versionDetail = (): string =>
            l10n.t("CLI {0} / SDK expected {1}", cliVersion ?? l10n.t("unknown"), expectedCliVersion() ?? l10n.t("unknown"));
          const seconds = (from: number | undefined): string => {
            if (from === undefined) return l10n.t("none");
            const total = Math.round((this.deps.now() - from) / 1000);
            return total < 60 ? l10n.t("{0}s", total) : l10n.t("{0}m {1}s", Math.floor(total / 60), total % 60);
          };
          // 待ちの終端に共通で載せる観測値。利用者が「止まっていた」のか「進んでいたが遅い」のかを見分ける材料
          const waitDetail = (): string =>
            l10n.t(
              "{0} since last response, {1} since summary started, {2} responses, {3}",
              seconds(lastHeartbeatAt),
              seconds(resultAt),
              compactingHeartbeats,
              versionDetail()
            );

          const rejectSummary = (reason: HandoffFailReason, headings: string[], body: string, raw: string): void => {
            this.deps.log(
              `handoff compact rejected: headings=${headings.length} [${headings.join("|")}] body=${body.length} chars`
            );
            void this.deps.writeDiagnostic?.(`${input.runId}-compact-rejected.txt`, raw)
              .then((p) => this.deps.log(`handoff compact raw saved: ${p}`))
              .catch((e) => this.deps.log(`handoff compact raw save failed: ${errorDetail(e)}`));
            if (this.commitTerminal(reason)) abortRun();
          };

          // acceptedBody を渡せるのは hook 経路だけ。stream の完了信号で進む経路で封筒 push の前に
          // F の読取（await）を挟むと query の終了と競合し、失敗すれば課金済み compact の喪失になる。
          // その経路は前世代の転記だけを積む（source: "previous_only"）
          const appendEnvelope = (acceptedBody?: string): void => {
            if (envelopeCount > 0) return;
            this.transition("appending");
            const decisions = mergeHandoffDecisions(
              previousDecisions,
              acceptedBody === undefined ? [] : extractDecisionLines(acceptedBody),
              acceptedBody === undefined ? "previous_only" : "hook"
            );
            const carryDecisions =
              decisions.entries.length > 0 || (decisions.removedLastGen?.length ?? 0) > 0 ? decisions : undefined;
            const envelope: HandoffEnvelopeV2 = {
              schema: "hb2",
              preamble: ENVELOPE_PREAMBLE,
              snapshot: {
                sourceSessionId: input.sourceSessionId,
                forkSessionId: forkSessionId!,
                capturedAt: new Date(this.deps.now()).toISOString(),
                ...(compact !== undefined ? { compact } : {}),
              },
              userUtterances: utterances,
              ...(carryDecisions !== undefined ? { decisions: carryDecisions } : {}),
            };
            try {
              queue.push({
                type: "user",
                message: { role: "user", content: buildHandoffEnvelopeV2(envelope) },
                parent_tool_use_id: null,
                session_id: forkSessionId,
                shouldQuery: false,
              });
              envelopeCount++;
              queue.close();
              this.transition("finishing");
            } catch (error) {
              if (this.commitTerminal("envelope_append_failed", errorDetail(error))) abortRun();
            }
          };

          // hook が来なくても stream の完了信号で先へ進む。要約の受理は commit 時に F の記録から行う
          const completeFromStream = (signal: "status" | "boundary"): void => {
            if (compactCompletedBy !== undefined) return;
            compactCompletedBy = signal;
            this.deps.log(`handoff compact completed by stream ${signal} without PostCompact`);
            appendEnvelope();
          };

          const onPostCompact: HookCallback = async (hookInput) => {
            if (this.terminal !== undefined) {
              this.deps.log("handoff late PostCompact ignored");
              return {};
            }
            if (hookInput.hook_event_name !== "PostCompact") return {};
            hookCount++;
            if (hookCount !== 1) {
              if (this.commitTerminal("commit_failed", "PostCompact fired more than once")) abortRun();
              return {};
            }
            if (compactCompletedBy !== undefined) {
              this.deps.log(`handoff PostCompact arrived after stream ${compactCompletedBy}; envelope already appended`);
              return {};
            }
            compactCompletedBy = "hook";

            this.transition("accepting");
            const accepted = acceptCompactSummary(hookInput.compact_summary);
            if (!accepted.ok) {
              rejectSummary(accepted.reason, accepted.headings, accepted.body, hookInput.compact_summary);
              return {};
            }
            acceptedByHook = true;
            appendEnvelope(accepted.body);
            return {};
          };

          // 進行が来るたびに引き直す。compact の所要時間は文脈量にほぼ比例するので、
          // 絶対時間の締め切りは大きい文脈で必ず途中で切り、完成した fork を捨てる。この上限が意味するのは「timeoutMs のあいだ CLI から
          // 何も来ない」= 止まったこと。値を伸ばす対処では文脈量が増えるたびに同じことが起きる
          let timer: ReturnType<typeof setTimeout> | undefined;
          const armTimeout = (): void => {
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(() => {
              if (this.commitTerminal("compact_timeout", waitDetail())) abortRun();
            }, this.deps.timeoutMs);
          };
          // ここで一度張る窓は CLI の起動と resume も含む（最初の stream メッセージが来るまで
          // 引き直されない）。894k tok の実測では resume 直後にメッセージが流れ、`result` は
          // duration_ms=111 で compact 本体が全体 181 s のほぼ全部だったが、**起動時間そのものは
          // 未測定**。極端に大きいセッションで最初の 1 通が timeoutMs を超えると開始前に落ちる
          armTimeout();

          try {
            const query = this.deps.sdk.query({
              prompt: queue,
              options: {
                cwd: this.deps.cwd,
                resume: forkSessionId,
                model: "opus",
                pathToClaudeCodeExecutable: this.deps.claudeExecutablePath,
                env: this.deps.env,
                abortController,
                canUseTool: async () => ({ behavior: "deny", message: "Handoff compaction does not allow tools" }),
                hooks: { PostCompact: [{ hooks: [onPostCompact] }] },
              },
            });
            this.query = query as unknown as { close?: () => void };
            drainStarted = true;
            for await (const message of query as AsyncIterable<SDKMessage>) {
              armTimeout();
              if (registryEntry !== undefined && this.terminal === undefined) await this.renewLease(registryEntry);
              const record = message as unknown as Record<string, unknown>;
              const isStatus = record.type === "system" && record.subtype === "status";
              if (this.terminal !== undefined) {
                // status は compact の成否を運ぶ唯一の経路。type/subtype だけでは真因が消える
                const statusDetail = isStatus
                  ? ` status=${String(record.status ?? "")} compact_result=${String(record.compact_result ?? "")} compact_error=${String(record.compact_error ?? "")}`
                  : "";
                this.deps.log(
                  `handoff late stream message ignored: ${String(record.type)}/${String(record.subtype ?? "")}${statusDetail}`
                );
                continue;
              }
              if (record.type === "system" && record.subtype === "init" && typeof record.claude_code_version === "string") {
                cliVersion = record.claude_code_version;
              }
              // CLI は compact を断ったことを system/status で理由付きに知らせるが、
              // 同じターンの result は success で返る（実測 2026-09-04: is_error=false・
              // num_turns=0・cost=0・本文 "Not enough messages to compact."）。
              // ここを見ないと「PostCompact が来なかった」だけが残って hook_not_fired へ丸められ、
              // 利用者には理由の無い生トークンが出る
              if (isStatus && record.compact_result === "failed") {
                const why =
                  typeof record.compact_error === "string" && record.compact_error.length > 0
                    ? record.compact_error
                    : l10n.t("No reason given");
                if (this.commitTerminal("compact_failed", why)) abortRun();
                continue;
              }
              if (isStatus && record.compact_result === "success") {
                completeFromStream("status");
                continue;
              }
              if (isStatus && record.status === "compacting") {
                compactingHeartbeats++;
                lastHeartbeatAt = this.deps.now();
                const since = resultAt === undefined ? "compact_start" : "result";
                const elapsedMs = lastHeartbeatAt - (resultAt ?? compactStartedAt ?? lastHeartbeatAt);
                this.deps.log(
                  `handoff compacting: heartbeat #${compactingHeartbeats}, ${Math.round(elapsedMs / 1000)}s since ${since === "result" ? "result" : "start"}`
                );
                this.deps.onProgress?.({ phase: "compacting", heartbeats: compactingHeartbeats, elapsedMs, since });
                continue;
              }
              if (record.type === "system" && record.subtype === "compact_boundary") {
                const metadata = asRecord(record.compact_metadata);
                if (
                  typeof metadata?.pre_tokens === "number" &&
                  Number.isFinite(metadata.pre_tokens) &&
                  typeof metadata.post_tokens === "number" &&
                  Number.isFinite(metadata.post_tokens)
                ) {
                  compact = { preTokens: metadata.pre_tokens, postTokens: metadata.post_tokens };
                }
                completeFromStream("boundary");
              }
              if (record.type === "result") {
                // 最初の result を保持する。後続で上書きすると error → success の順で
                // 届いた列が success として commit される
                resultMessage ??= record;
                resultAt ??= this.deps.now();
                // subtype を先に見る。hook 未着かどうかより「何が起きたか」が優先で、
                // hook 前の失敗 result を hook_not_fired へ丸めない
                if (record.subtype !== "success") {
                  const reason: HandoffFailReason =
                    this.phase === "compacting" ? "compact_failed" : "commit_failed";
                  if (this.commitTerminal(reason, `result subtype=${String(record.subtype)}`)) abortRun();
                } else if (compactCompletedBy === undefined) {
                  // success の result は compact 完了の証拠にならない（COMPACT_HEARTBEAT_GRACE_MS の注記）。
                  // ここで打ち切らない。以後の沈黙は armTimeout が同じ上限で縛る
                  this.deps.log("handoff result before compact completion; waiting for status/boundary/hook");
                }
              }
            }
          } catch (error) {
            if (this.terminal === undefined) {
              // 封筒を積んだ後の iterator error は SDK が封筒を消費できなかったということ
              const reason: HandoffFailReason =
                this.phase === "compacting"
                  ? "compact_failed"
                  : this.phase === "appending" || this.phase === "finishing"
                    ? "envelope_append_failed"
                    : "commit_failed";
              this.commitTerminal(reason, errorDetail(error));
            } else {
              this.deps.log(`handoff late iterator error ignored: ${errorDetail(error)}`);
            }
          } finally {
            clearTimeout(timer);
            queue.close();
          }

          if (this.terminal === undefined && compactCompletedBy === undefined) {
            this.commitTerminal(
              "hook_not_fired",
              l10n.t("No compact signal until stream end (result={0}), {1}", String(resultMessage?.subtype ?? "none"), waitDetail())
            );
          }

          if (this.terminal === undefined) {
            // 条件の OR で落とすと「どれが崩れたか」が残らず、再発時に原因を追えない。
            // 短絡の順序は変えない。読み取りは前の条件を通ったときだけ行う
            const why: string[] = [];
            if (resultMessage?.subtype !== "success") {
              why.push(`result=${resultMessage?.subtype ?? "none"}`);
            }
            if (envelopeCount !== 1) why.push(`envelope=${envelopeCount}`);
            if (why.length === 0) {
              const commitRead = await this.deps.readRecords(forkFilePath);
              commitRecords = commitRead.records;
              unreadableLineCount = Math.max(unreadableLineCount, commitRead.unreadableLineCount);
              if (!acceptedByHook) {
                // hook が要約を受理していない経路（未着・stream 完了後の遅着）。受理は F の記録から
                // 同じ規則で行う（fail-closed、R-HND-03）
                const summaries = compactSummariesAfter(commitRecords, lastCompactBoundaryIndex(commitRecords));
                const raw = summaries.length === 1 ? textFromRecord(summaries[0]) : undefined;
                const accepted = raw === undefined ? undefined : acceptCompactSummary(raw);
                if (accepted !== undefined && !accepted.ok) {
                  rejectSummary(accepted.reason, accepted.headings, accepted.body, raw!);
                  return this.failureOutcome(input.runId, forkSessionId);
                }
              }
              const incomplete = forkIncompleteReason(commitRecords, forkSessionId);
              if (incomplete !== undefined) why.push(`fork=${incomplete}`);
            }
            if (why.length > 0) {
              this.commitTerminal("commit_failed", why.join(" "));
            } else {
              // 展開部はこの時点の記録から 1 回だけ取る。part 要求のたびに読み直すと、
              // 以後の発言や再 compact で要約と part 境界が変わる
              detail = extractHandoffDetail(commitRecords ?? [], forkSessionId);
              this.commitTerminal("done");
            }
          }
          } catch (error) {
            if (this.terminal === undefined) {
              this.commitTerminal(
                this.phase === "extracting" ? "verbatim_extract_failed" : "commit_failed",
                errorDetail(error)
              );
            }
          }
        }
      }
    } catch (error) {
      if (this.terminal === undefined) {
        const reason: HandoffFailReason =
          this.phase === "forking"
            ? "fork_failed"
            : this.phase === "extracting"
              ? "verbatim_extract_failed"
              : "commit_failed";
        this.commitTerminal(reason, errorDetail(error));
      }
    } finally {
      if (this.terminal !== "done" && drainStarted) this.abortController?.abort();
      if (registryEntry !== undefined) {
        if (this.terminal !== "done" && forkFilePath !== undefined) {
          await this.deleteFailedFork(registryEntry);
        }
        await this.removeRegistryEntry(IN_FLIGHT_KEY, registryEntry.filePath);
      }
    }

    if (this.terminal === "done" && forkSessionId !== undefined && forkFilePath !== undefined) {
      return {
        ok: true,
        runId: input.runId,
        forkSessionId,
        forkFilePath,
        ...(compact !== undefined ? { compact } : {}),
        ...(detail !== undefined ? { detail } : {}),
        utteranceCount,
        unreadableLineCount,
      };
    }
    return this.failureOutcome(input.runId, forkSessionId);
  }

  private failureOutcome(runId: string, forkSessionId?: string): HandoffOutcome {
    const reason = this.terminal === undefined || this.terminal === "done" ? "compact_failed" : this.terminal;
    return {
      ok: false,
      runId,
      reason,
      ...(this.terminalDetail !== undefined ? { detail: this.terminalDetail } : {}),
      ...(forkSessionId !== undefined ? { forkSessionId } : {}),
    };
  }

  private async addRegistryEntry(key: string, entry: PersistedHandoff): Promise<void> {
    const entries = persistedEntries(this.deps.persist.get(key));
    entries.push(entry);
    await this.deps.persist.update(key, entries.slice(-MAX_PERSISTED_HANDOFFS));
  }

  // 別ウィンドウの起動時清掃へ「まだ動いている」を伝える（AUDIT-05）。**登録時の刻印だけにしないこと**——
  // 絶対時間の締め切りになり、compact の所要時間は文脈量にほぼ比例するので、大きい文脈で稼働中の fork が消される
  private async renewLease(entry: PersistedHandoff): Promise<void> {
    const entries = persistedEntries(this.deps.persist.get(IN_FLIGHT_KEY));
    const index = entries.findIndex((candidate) => candidate.filePath === entry.filePath);
    // 登録が既に無いなら書き戻さない（他ウィンドウが消した entry を復活させない）
    if (index < 0) return;
    entries[index] = { ...entries[index], leaseUntil: this.deps.now() + HANDOFF_LEASE_MS };
    await this.deps.persist.update(IN_FLIGHT_KEY, entries);
  }

  private async removeRegistryEntry(key: string, filePath: string): Promise<void> {
    const entries = persistedEntries(this.deps.persist.get(key)).filter((entry) => entry.filePath !== filePath);
    await this.deps.persist.update(key, entries);
  }

  private async deleteFailedFork(entry: PersistedHandoff): Promise<void> {
    const projectsRoot = path.resolve(claudeProjectsDir());
    if (!isWithinProjects(entry.filePath, projectsRoot)) {
      this.deps.log(`handoff orphan outside projects root: ${entry.forkSessionId}`);
      await this.addRegistryEntry(ORPHANS_KEY, entry);
      return;
    }
    for (const delay of UNLINK_RETRY_DELAYS_MS) {
      await (this.deps.sleep ?? sleep)(delay);
      try {
        await this.deps.fs.unlink(entry.filePath);
        return;
      } catch (error) {
        this.deps.log(`handoff unlink failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
      }
    }
    await this.addRegistryEntry(ORPHANS_KEY, entry);
  }

  // **activation でだけ呼ぶこと。**lease が見えるのは、起動時の Memento が他ウィンドウの書き込みを
  // 読み直した直後だからで、長命プロセスの周期実行へ移すとキャッシュが古いまま固定され、
  // lease を見ているのに稼働中の fork を消す状態へ黙って戻る（AUDIT-05）
  static async sweepOrphans(
    deps: Pick<HandoffRunnerDeps, "fs" | "persist" | "readRecords" | "log"> & { now?: () => number },
    projectsRoot: string
  ): Promise<{ deleted: string[]; kept: string[]; failed: string[]; active: string[] }> {
    const now = deps.now?.() ?? Date.now();
    const inFlight = persistedEntries(deps.persist.get(IN_FLIGHT_KEY));
    const orphans = persistedEntries(deps.persist.get(ORPHANS_KEY));
    // ORPHANS は所有者が破棄すると決めた後の登録なので lease を見ない
    const abandoned = new Set(orphans.map((entry) => entry.filePath));

    const active = new Map<string, PersistedHandoff>();
    for (const entry of inFlight) {
      if (abandoned.has(entry.filePath)) continue;
      if (entry.leaseUntil > now) {
        active.set(entry.filePath, entry);
        deps.log(
          `handoff sweep skipped live handoff: ${entry.forkSessionId} owner=${entry.owner} lease=${entry.leaseUntil - now}ms`
        );
      }
    }

    const entries = [...inFlight, ...orphans];
    const unique = [...new Map(entries.map((entry) => [entry.filePath, entry])).values()].filter(
      (entry) => !active.has(entry.filePath)
    );
    const deleted: string[] = [];
    const kept: string[] = [];
    const failed: string[] = [];

    for (const entry of unique) {
      try {
        await deps.fs.readFile(entry.filePath);
      } catch (error) {
        const code = asRecord(error)?.code;
        if (code === "ENOENT") {
          deleted.push(entry.filePath);
          continue;
        }
        failed.push(entry.filePath);
        deps.log(`handoff orphan read failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
        continue;
      }

      let complete = false;
      try {
        complete =
          forkIncompleteReason((await deps.readRecords(entry.filePath)).records, entry.forkSessionId) === undefined;
      } catch (error) {
        // 読めない F は完成品と判定できない＝残す理由が無いので削除側へ回す
        deps.log(`handoff orphan parse failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
      }
      if (complete) {
        kept.push(entry.filePath);
        continue;
      }
      if (!isWithinProjects(entry.filePath, projectsRoot)) {
        failed.push(entry.filePath);
        deps.log(`handoff orphan outside projects root: ${entry.forkSessionId}`);
        continue;
      }
      try {
        await deps.fs.unlink(entry.filePath);
        deleted.push(entry.filePath);
      } catch (error) {
        failed.push(entry.filePath);
        deps.log(`handoff orphan unlink failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
      }
    }

    const remaining = new Set(failed);
    // 稼働中と判定した entry は登録に残す。落とすと renewLease は書き戻さないので、以後この fork を起動時清掃が追えない
    await deps.persist.update(
      IN_FLIGHT_KEY,
      persistedEntries(deps.persist.get(IN_FLIGHT_KEY))
        .filter((entry) => active.has(entry.filePath) || remaining.has(entry.filePath))
    );
    await deps.persist.update(
      ORPHANS_KEY,
      persistedEntries(deps.persist.get(ORPHANS_KEY)).filter((entry) => remaining.has(entry.filePath))
    );
    return { deleted, kept, failed, active: [...active.keys()] };
  }
}
