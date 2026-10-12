const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function isClosingFence(line: string, opening: string): boolean {
  const match = line.match(FENCE_RE);
  return !!match && match[1][0] === opening[0] && match[1].length >= opening.length && match[2].trim() === "";
}

export function recordSeparator(text: string): string {
  if (text.trim() === "" || /\n[ \t]*\n[ \t]*$/.test(text)) return "";
  return /\n[ \t]*$/.test(text) ? "\n" : "\n\n";
}

export function joinRecordTexts(texts: readonly string[]): string {
  let joined = "";
  for (const text of texts) joined += recordSeparator(joined) + text;
  return joined;
}

export interface RecordTextPart {
  text: string;
  uuid: string | null;
  complete?: true;
}

export function appendRecordPart(parts: RecordTextPart[], part: RecordTextPart): void {
  const last = parts.at(-1);
  // A completed text record starts its own part; a later UUID can still label
  // the ordinary stream that preceded it.
  if (part.complete) {
    parts.push({ ...part });
  } else if (part.text === "" && part.uuid !== null && last?.complete) {
    if (last?.uuid === part.uuid) return;
    let pending: RecordTextPart | undefined;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].uuid === null && !parts[i].complete) { pending = parts[i]; break; }
    }
    if (pending !== undefined) pending.uuid = part.uuid;
    else parts.push({ ...part });
  } else if (last !== undefined && last.uuid === null && !last.complete) {
    last.text += part.text;
    last.uuid = part.uuid;
  } else {
    parts.push({ ...part });
  }
}

export function prependRecordParts(older: readonly RecordTextPart[], newer: readonly RecordTextPart[]): RecordTextPart[] {
  const parts: RecordTextPart[] = [];
  for (const part of [...older, ...newer]) appendRecordPart(parts, part);
  return parts;
}

export function findCommitBoundary(buf: string, committedLen: number): number {
  let boundary = -1;
  let fence: { char: string; len: number } | null = null;
  let pos = committedLen;
  const lines = buf.slice(committedLen).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(FENCE_RE);
    if (m) {
      const run = m[1];
      const rest = m[2];
      if (fence === null) {
        if (!(run[0] === "`" && rest.includes("`"))) fence = { char: run[0], len: run.length };
      } else if (isClosingFence(line, fence.char.repeat(fence.len))) {
        fence = null;
      }
    }
    pos += line.length + 1;
    if (fence === null && line.trim() === "" && pos > committedLen) boundary = pos;
  }
  return boundary >= buf.length ? -1 : boundary;
}
