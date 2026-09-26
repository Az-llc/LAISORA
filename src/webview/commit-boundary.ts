// CommonMark 4.5: 閉じフェンスは開きと同じ文字で、開きの長さ以上、info 文字列なし。
// 文字と長さを見ないと ``` の内側の ~~~ や短い ``` で閉じたと誤認し、
// 続く行（参照定義など）が別 chunk へ確定されて表示から消える（Sol S-1 で実証）
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function isClosingFence(line: string, opening: string): boolean {
  const match = line.match(FENCE_RE);
  return !!match && match[1][0] === opening[0] && match[1].length >= opening.length && match[2].trim() === "";
}

// 本文の記録（wire uuid を持つ assistant フレーム 1 件）同士は段落で区切る。復元は記録ごとに
// 別区画で描くので、live で区切らずに連結すると次の記録の先頭フェンスが行頭から外れ、
// laisora-ask / laisora-plan が通常の本文になる。ツール呼び出しは区切りにしない（R-DSP-24）
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
}

// A page can end inside a record or contain only its trailing UUID. Keep that
// marker until the older page arrives; a tool call is never a record boundary.
export function appendRecordPart(parts: RecordTextPart[], part: RecordTextPart): void {
  const last = parts.at(-1);
  if (last !== undefined && last.uuid === null) {
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

// committedLen ではコードフェンスが閉じていることを呼び出し側が保証する。破ると誤答になる。
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
