import * as l10n from "@vscode/l10n";

export const SESSION_TITLE_INDEX_VERSION = 1;

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

export function normalizeTitleValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const firstLine = raw.split("\n")[0] ?? "";
  const cleaned = firstLine.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.length === 0 ? null : cleaned;
}

export function formatSessionTitleForDisplay(title: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const points = Array.from(title);
  if (points.length <= maxLength) return title;
  return `${points.slice(0, maxLength).join("")}…`;
}

export function formatCustomTitleRecord(sessionId: string, customTitle: string): string {
  return `${JSON.stringify({ type: "custom-title", customTitle, sessionId })}\n`;
}

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

export type ParsedTitleRecord =
  | { kind: "candidate"; source: SessionTitleCandidateSource; value: string; byteOffset: number }
  | { kind: "meta"; sessionId?: string; cwd?: string };

const INJECTED_TAG_RE =
  /^<\/?(?:laisora-handoff|laisora-steer|command-message|command-name|command-args|local-command-[a-z-]+|system-reminder|task-notification)[\s>]/i;

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
      if (!candidates["first-human-utterance"]) candidates["first-human-utterance"] = next;
      continue;
    }
    const existing = candidates[parsed.source];
    if (!existing || next.byteOffset >= existing.byteOffset) candidates[parsed.source] = next;
  }

  return { candidates, sessionId, cwd };
}

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
