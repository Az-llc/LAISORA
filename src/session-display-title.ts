// セッション表示名の解決規則と、その入力を作る差分インデックスの純関数群。
// I/O はこのモジュールに入れない（呼び出し側が read/stat を行い、結果を渡す）。
//
// Claude Code のセッション JSONL の実測事実（2026-08-18, CLI 2.1.233 / corpus 2149ファイル）:
//  - `custom-title` は /rename でのみ書かれる。`ai-title` は自動命名で、**rename 後も
//    旧い自動命名の値で再出力され続ける**。よって「最後に現れたタイトル系レコード」を
//    採用すると誤る。型ごとの優先順位が必須。
//  - これらのメタレコードは timestamp を持たず、メッセージ列と時系列順に並ばない
//    （/rename コマンドの user レコードより前に custom-title が現れる実例がある）。
//    順序の判定に使えるのはバイトオフセットだけ。
//  - `agent-name` は直前の ai-title / custom-title と常に同値の写し（47/47）で、
//    出現率も低い。表示名の解決には使わない。混入を構造的に防ぐため
//    SessionTitleCandidateSource に含めず、parseTitleRecord で捨てる。

import * as l10n from "@vscode/l10n";

export const SESSION_TITLE_INDEX_VERSION = 1;

// 前回読了位置の直前この長さのバイト列で追記ファイルの同一性を検証する。
// 値を変えると既存キャッシュの fingerprint と比較できなくなるため、
// index エントリ側にも記録して不一致なら full rescan する。
export const FINGERPRINT_WINDOW_BYTES = 512;

export type SessionTitleSource =
  | "claude-custom-title"
  | "claude-ai-title"
  | "first-human-utterance"
  | "untitled";

export type SessionTitleCandidateSource = Exclude<SessionTitleSource, "untitled">;

export interface TitleCandidate {
  value: string;
  byteOffset: number;
}

export type SessionTitleCandidates = Partial<Record<SessionTitleCandidateSource, TitleCandidate>>;

// 解決順。`claude-ai-title` は型にあるがこの配列に無いので採用されない。
export const DEFAULT_TITLE_PRIORITY: readonly SessionTitleCandidateSource[] = [
  "claude-custom-title",
  "first-human-utterance",
];

export function untitledLabel(): string {
  return l10n.t("(Untitled)");
}

export interface ResolvedSessionTitle {
  title: string;
  source: SessionTitleSource;
  byteOffset?: number;
}

// ---------------------------------------------------------------- 値の正規化

// 空文字・空白のみ（U+3000 / U+FEFF を含む。JS の \s はどちらも含むので trim で落ちる）は
// 候補として成立しない。制御文字はタブ表示とアクセシビリティラベルを壊すので空白へ潰す。
export function normalizeTitleValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const firstLine = raw.split("\n")[0] ?? "";
  const cleaned = firstLine.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.length === 0 ? null : cleaned;
}

// 表示幅の切り詰めは解決規則から分離する（履歴一覧とタブで上限が異なるため）。
// コードポイント単位で切るので、既存の UTF-16 slice と違いサロゲートペアを割らない。
export function formatSessionTitleForDisplay(title: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const points = Array.from(title);
  if (points.length <= maxLength) return title;
  return `${points.slice(0, maxLength).join("")}…`;
}

// /rename で Host が書く custom-title レコード。CLI（2.1.233 実測）が書く形そのもの:
// 1 行の JSON・キー順 type, customTitle, sessionId・timestamp 無し。形が違うと SDK の解決器
// （末尾 64KB の customTitle）と parseTitleRecord の両方から見えなくなる（R-SES-05）
export function formatCustomTitleRecord(sessionId: string, customTitle: string): string {
  return `${JSON.stringify({ type: "custom-title", customTitle, sessionId })}\n`;
}

// ---------------------------------------------------------------- 解決規則

export function resolveSessionDisplayTitle(
  candidates: SessionTitleCandidates,
  options?: {
    priority?: readonly SessionTitleCandidateSource[];
    untitledLabel?: string;
  }
): ResolvedSessionTitle {
  const priority = options?.priority ?? DEFAULT_TITLE_PRIORITY;
  for (const source of priority) {
    const candidate = candidates[source];
    if (!candidate) continue;
    const value = normalizeTitleValue(candidate.value);
    if (value === null) continue;
    return { title: value, source, byteOffset: candidate.byteOffset };
  }
  return { title: options?.untitledLabel ?? untitledLabel(), source: "untitled" };
}

// ---------------------------------------------------------------- レコード解釈

export type ParsedTitleRecord =
  | { kind: "candidate"; source: SessionTitleCandidateSource; value: string; byteOffset: number }
  | { kind: "meta"; sessionId?: string; cwd?: string };

const INJECTED_TAG_RE =
  /^<\/?(?:laisora-handoff|laisora-steer|command-message|command-name|command-args|local-command-[a-z-]+|system-reminder|task-notification)[\s>]/i;

// 既定の人間発話判定。正本は session-transcript.extractHumanUserText であり、配線時は
// そちらを extractHumanText で注入して本関数を使わないのが望ましい。正本と意図的に
// 異なるのは3点で、いずれも「表示名の入力としては厳しめに落とす」方向:
//  1. `<command-name>` 系の引数を返さない。正本は args を人間発話として返すため
//     `/rename stage4,5` が初回発言になる（表示名以外の派生値へ rename が波及する）
//  2. 先頭が `/コマンド` の生テキストを一律に落とす。正本は引数なしの既知コマンドだけを
//     落とすので `/model opus` は人間発話になる。副作用として `/tmp を見て` のような
//     実在しうる人間発話も落ちる（表示名の候補としては許容する）
//  3. INJECTED_TAG_RE に `command-args` を足してある
export function defaultExtractHumanText(record: unknown): string | null {
  if (!isRecord(record)) return null;
  if (record.type !== "user" || record.isSidechain === true) return null;
  const origin = isRecord(record.origin) ? record.origin : null;
  if (origin && origin.kind !== "human") return null;
  const message = isRecord(record.message) ? record.message : null;
  const text = extractTextBlocks(message?.content);
  if (!text) return null;
  if (INJECTED_TAG_RE.test(text)) return null;
  if (text.startsWith("Caveat:")) return null;
  if (text.startsWith("Base directory for this skill:")) return null;
  if (text === "[Request interrupted by user]" || text === "[Request interrupted by user for tool use]") {
    return null;
  }
  if (/^\/[a-z][a-z0-9:_-]*(\s|$)/i.test(text)) return null;
  return text;
}

function extractTextBlocks(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => isRecord(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .filter((t) => !t.startsWith("<ide_") && !t.startsWith("<system-reminder>"))
    .join("\n")
    .trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface ParseOptions {
  // 省略推奨。省略すると foldTitleRecords がファイル内で最初に見つけた sessionId を基準にする。
  // ファイル名由来の id を渡すと、全レコードが別 id を持つファイル（corpus に実在。
  // 4ec6ec9d-….jsonl の中身は fa8fc424-… だった）で全レコードが弾かれ untitled に落ちる。
  // 推論に任せれば、その種のファイルでも表示名が出たうえで、一貫したファイルへ紛れ込んだ
  // 異物レコードだけを落とせる。
  sessionId?: string;
  extractHumanText?: (record: unknown) => string | null;
}

export function parseTitleRecord(
  record: unknown,
  byteOffset: number,
  options?: ParseOptions
): ParsedTitleRecord | null {
  if (!isRecord(record)) return null;
  const recordSessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
  // fork や別セッションの断片が混じったファイルが実在する（corpus 1757件中1件）。
  if (options?.sessionId && recordSessionId && recordSessionId !== options.sessionId) return null;

  switch (record.type) {
    case "custom-title": {
      const value = normalizeTitleValue(record.customTitle);
      return value === null ? null : { kind: "candidate", source: "claude-custom-title", value, byteOffset };
    }
    case "ai-title": {
      const value = normalizeTitleValue(record.aiTitle);
      return value === null ? null : { kind: "candidate", source: "claude-ai-title", value, byteOffset };
    }
    case "agent-name":
      return null;
    case "user": {
      const extract = options?.extractHumanText ?? defaultExtractHumanText;
      const value = normalizeTitleValue(extract(record));
      if (value === null) {
        return recordSessionId || typeof record.cwd === "string"
          ? { kind: "meta", sessionId: recordSessionId, cwd: typeof record.cwd === "string" ? record.cwd : undefined }
          : null;
      }
      return { kind: "candidate", source: "first-human-utterance", value, byteOffset };
    }
    default: {
      if (!recordSessionId && typeof record.cwd !== "string") return null;
      return {
        kind: "meta",
        sessionId: recordSessionId,
        cwd: typeof record.cwd === "string" ? record.cwd : undefined,
      };
    }
  }
}

// ---------------------------------------------------------------- 差分インデックス

export interface SessionTitleIndexEntry {
  version: number;
  size: number;
  mtimeMs: number;
  consumedBytes: number;
  fingerprint: string;
  fingerprintWindow: number;
  candidates: SessionTitleCandidates;
  sessionId?: string;
  cwd?: string;
}

export type ScanPlan =
  | { mode: "full"; reason: FullRescanReason }
  | { mode: "verify"; windowStart: number; windowEnd: number; expectedFingerprint: string };

export type FullRescanReason =
  | "no-entry"
  | "version-mismatch"
  | "malformed-entry"
  | "fingerprint-window-changed"
  | "size-shrank"
  | "mtime-rewound"
  | "fingerprint-mismatch";

export interface FileStatLike {
  size: number;
  mtimeMs: number;
}

// mtime と size だけでは同サイズの書き換えを検出できないので、必ず fingerprint 検証を挟む。
// 変化が無く見えるときも verify を返す（512バイト読むだけで、40ファイルでも 1ms 程度）。
export function planSessionTitleScan(
  entry: SessionTitleIndexEntry | undefined | null,
  stat: FileStatLike
): ScanPlan {
  if (!entry) return { mode: "full", reason: "no-entry" };
  if (entry.version !== SESSION_TITLE_INDEX_VERSION) return { mode: "full", reason: "version-mismatch" };
  if (
    typeof entry.consumedBytes !== "number" ||
    !Number.isFinite(entry.consumedBytes) ||
    entry.consumedBytes < 0 ||
    typeof entry.fingerprint !== "string" ||
    !isRecord(entry.candidates)
  ) {
    return { mode: "full", reason: "malformed-entry" };
  }
  if (entry.fingerprintWindow !== FINGERPRINT_WINDOW_BYTES) {
    return { mode: "full", reason: "fingerprint-window-changed" };
  }
  if (entry.consumedBytes === 0) return { mode: "full", reason: "no-entry" };
  if (stat.size < entry.consumedBytes) return { mode: "full", reason: "size-shrank" };
  if (stat.mtimeMs < entry.mtimeMs) return { mode: "full", reason: "mtime-rewound" };
  return {
    mode: "verify",
    windowStart: Math.max(0, entry.consumedBytes - FINGERPRINT_WINDOW_BYTES),
    windowEnd: entry.consumedBytes,
    expectedFingerprint: entry.fingerprint,
  };
}

export type ConfirmedPlan =
  | { mode: "full"; reason: FullRescanReason }
  | { mode: "incremental"; fromByte: number; hasNewBytes: boolean };

export function confirmSessionTitleScan(
  entry: SessionTitleIndexEntry,
  stat: FileStatLike,
  actualFingerprint: string
): ConfirmedPlan {
  if (actualFingerprint !== entry.fingerprint) return { mode: "full", reason: "fingerprint-mismatch" };
  return { mode: "incremental", fromByte: entry.consumedBytes, hasNewBytes: stat.size > entry.consumedBytes };
}

// FNV-1a 64bit。改竄検知ではなく「同じ追記ファイルか」の判定なので暗号学的強度は不要。
export function fingerprintBytes(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash ^ BigInt(bytes[i])) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export interface ScannedLine {
  text: string;
  byteOffset: number;
}

export interface SplitResult {
  lines: ScannedLine[];
  consumedBytes: number;
}

// 末尾の未完成行は消費しない。次回の増分読みで先頭から読み直させる。
// 改行探索をバイト列で行うのは、UTF-8 の継続バイトが 0x0a を取り得ないため安全であり、
// かつ byteOffset を文字数ではなくバイト数で正確に出すため（日本語ログで両者はずれる）。
export function splitCompleteLines(chunk: Uint8Array, baseOffset: number): SplitResult {
  const decoder = new TextDecoder("utf-8");
  const lines: ScannedLine[] = [];
  let lineStart = 0;
  let consumed = baseOffset;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] !== 0x0a) continue;
    let end = i;
    if (end > lineStart && chunk[end - 1] === 0x0d) end--;
    if (end > lineStart) {
      lines.push({
        text: decoder.decode(chunk.subarray(lineStart, end)),
        byteOffset: baseOffset + lineStart,
      });
    }
    lineStart = i + 1;
    consumed = baseOffset + lineStart;
  }
  return { lines, consumedBytes: consumed };
}

export interface FoldResult {
  candidates: SessionTitleCandidates;
  sessionId?: string;
  cwd?: string;
}

export function foldTitleRecords(prior: FoldResult, lines: readonly ScannedLine[], options?: ParseOptions): FoldResult {
  const candidates: SessionTitleCandidates = { ...prior.candidates };
  let sessionId = prior.sessionId;
  let cwd = prior.cwd;

  for (const line of lines) {
    const trimmed = line.text.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = parseTitleRecord(record, line.byteOffset, {
      sessionId: options?.sessionId ?? sessionId,
      extractHumanText: options?.extractHumanText,
    });
    if (!parsed) continue;
    if (parsed.kind === "meta") {
      if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;
      if (!cwd && parsed.cwd) cwd = parsed.cwd;
      continue;
    }
    if (isRecord(record) && typeof record.sessionId === "string" && !sessionId) sessionId = record.sessionId;
    if (isRecord(record) && typeof record.cwd === "string" && !cwd) cwd = record.cwd;

    const next: TitleCandidate = { value: parsed.value, byteOffset: parsed.byteOffset };
    if (parsed.source === "first-human-utterance") {
      // 初回発言は単調: 一度決まったら後続で上書きしない
      if (!candidates["first-human-utterance"]) candidates["first-human-utterance"] = next;
      continue;
    }
    const existing = candidates[parsed.source];
    if (!existing || next.byteOffset >= existing.byteOffset) candidates[parsed.source] = next;
  }

  return { candidates, sessionId, cwd };
}

// tailBytes は fingerprintWindowFor(split.consumedBytes) の区間を**別途読み直した**バイト列。
// 今読んだ増分チャンクを流用してはいけない: 追記が 512 バイト未満のとき窓は fromByte より
// 手前から始まるので、チャンク先頭を窓の先頭とみなすと fingerprint が静かに壊れる。
export function applyScanResult(
  prior: SessionTitleIndexEntry | undefined | null,
  mode: "full" | "incremental",
  stat: FileStatLike,
  split: SplitResult,
  tailBytes: Uint8Array,
  options?: ParseOptions
): SessionTitleIndexEntry {
  const base: FoldResult =
    mode === "incremental" && prior
      ? { candidates: prior.candidates, sessionId: prior.sessionId, cwd: prior.cwd }
      : { candidates: {} };
  const folded = foldTitleRecords(base, split.lines, options);
  return {
    version: SESSION_TITLE_INDEX_VERSION,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    consumedBytes: split.consumedBytes,
    fingerprint: fingerprintBytes(tailBytes),
    fingerprintWindow: FINGERPRINT_WINDOW_BYTES,
    candidates: folded.candidates,
    sessionId: folded.sessionId,
    cwd: folded.cwd,
  };
}

// 呼び出し側が読むべき fingerprint 窓。applyScanResult へ渡す tailBytes と対で使う。
export function fingerprintWindowFor(consumedBytes: number): { start: number; end: number } {
  return { start: Math.max(0, consumedBytes - FINGERPRINT_WINDOW_BYTES), end: consumedBytes };
}

export function resolveFromIndexEntry(
  entry: SessionTitleIndexEntry,
  extra?: SessionTitleCandidates,
  options?: { priority?: readonly SessionTitleCandidateSource[]; untitledLabel?: string }
): ResolvedSessionTitle {
  return resolveSessionDisplayTitle({ ...entry.candidates, ...extra }, options);
}
