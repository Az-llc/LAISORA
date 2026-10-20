type SessionTitleCandidateSource = "claude-custom-title" | "claude-ai-title" | "first-human-utterance";

interface TitleCandidate {
  value: string;
  byteOffset: number;
}

type SessionTitleCandidates = Partial<Record<SessionTitleCandidateSource, TitleCandidate>>;

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

type ParsedTitleRecord =
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

interface ParseOptions {
  sessionId?: string;
  extractHumanText?: (record: unknown) => string | null;
}

function parseTitleRecord(
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

interface ScannedLine {
  text: string;
  byteOffset: number;
}

interface SplitResult {
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
