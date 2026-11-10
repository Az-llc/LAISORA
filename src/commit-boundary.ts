import { closesPlainAsk, opensPlainAsk } from "./ask-plain-form";

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

export function isClosingFence(line: string, opening: string): boolean {
  const match = line.match(FENCE_RE);
  return !!match && match[2][0] === opening[0] && match[2].length >= opening.length && match[3].trim() === "";
}

export function fenceOpening(line: string): { indent: string; marker: string; info: string } | null {
  const match = line.match(FENCE_RE);
  return match && !(match[2][0] === "`" && match[3].includes("`")) ? { indent: match[1], marker: match[2], info: match[3] } : null;
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

export function withoutRetracted<T extends { uuid: string | null }>(parts: readonly T[], uuids: readonly string[]): T[] {
  const dropped = new Set(uuids);
  return parts.filter((part) => part.uuid === null || !dropped.has(part.uuid));
}

export function prependRecordParts(older: readonly RecordTextPart[], newer: readonly RecordTextPart[]): RecordTextPart[] {
  const parts: RecordTextPart[] = [];
  for (const part of [...older, ...newer]) appendRecordPart(parts, part);
  return parts;
}

const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const ORDERED_ITEM = /^ {0,3}\d{1,9}[.)](?:[ \t]|$)/;
const BULLET_ITEM = /^ {0,3}[-+*](?:[ \t]|$)/;
const NESTED_BULLET_ITEM = /^[ \t]*[-+*](?:[ \t]|$)/;
const TABLE_DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const CODE_INDENT = /^(?: {4}|\t)/;

type PlainAskHold = "none" | "head" | "list";

const tableCells = (row: string): number => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length;

function startsTable(previous: string, line: string): boolean {
  return line.includes("|") && previous.includes("|") && TABLE_DELIMITER_ROW.test(line) && tableCells(previous) === tableCells(line);
}

function stepPlainAskHold(hold: PlainAskHold, line: string, previous: string, fenceOpens: boolean): PlainAskHold {
  if (opensPlainAsk(line)) return "head";
  if (hold === "none" || line.trim() === "") return hold;
  if (fenceOpens || closesPlainAsk(line) || ATX_HEADING.test(line)) return "none";
  const afterBlank = previous.trim() === "";
  if (hold === "head") {
    if (afterBlank && CODE_INDENT.test(line)) return "none";
    if (ORDERED_ITEM.test(line)) return "list";
    return BULLET_ITEM.test(line) || THEMATIC_BREAK.test(line) || (!afterBlank && startsTable(previous, line)) ? "none" : hold;
  }
  if (ORDERED_ITEM.test(line)) return hold;
  return afterBlank && !NESTED_BULLET_ITEM.test(line) ? "none" : hold;
}

export function findCommitBoundary(buf: string, committedLen: number): number {
  let boundary = -1;
  let fence: { char: string; len: number } | null = null;
  let hold: PlainAskHold = "none";
  let previous = "";
  let pos = committedLen;
  const lines = buf.slice(committedLen).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence === null) {
      const opening = fenceOpening(line);
      if (opening) fence = { char: opening.marker[0], len: opening.marker.length };
      hold = stepPlainAskHold(hold, line, previous, opening !== null);
    } else if (isClosingFence(line, fence.char.repeat(fence.len))) {
      fence = null;
    }
    previous = line;
    pos += line.length + 1;
    if (fence === null && hold === "none" && line.trim() === "" && pos > committedLen) boundary = pos;
  }
  return boundary >= buf.length ? -1 : boundary;
}
