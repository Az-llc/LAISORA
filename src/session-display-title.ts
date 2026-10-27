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

export function recordCwds(lines: readonly ScannedLine[]): string[] {
  const cwds: string[] = [];
  let sessionId: string | undefined;
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line.text.trim());
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
    const fields = record as Record<string, unknown>;
    const recordSessionId = typeof fields.sessionId === "string" ? fields.sessionId : undefined;
    if (sessionId !== undefined && recordSessionId !== undefined && recordSessionId !== sessionId) continue;
    sessionId ??= recordSessionId;
    if (typeof fields.cwd === "string" && !cwds.includes(fields.cwd)) cwds.push(fields.cwd);
  }
  return cwds;
}
