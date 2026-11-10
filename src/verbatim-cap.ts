export const VERBATIM_UTTERANCE_MAX_CHARS = 1000;

const CUT_BEFORE = "\n[... ";
const CUT_AFTER = " characters omitted here; the full text is in the previous session's transcript ...]\n";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CUT_RE = new RegExp(`${escapeRegExp(CUT_BEFORE)}(\\d+)${escapeRegExp(CUT_AFTER)}`, "g");

function cutMarker(omitted: number): string {
  return `${CUT_BEFORE}${omitted}${CUT_AFTER}`;
}

export function verbatimMiddleCut(text: string): { cut: string; markerChars: number } {
  const chars = Array.from(text);
  let keep = VERBATIM_UTTERANCE_MAX_CHARS / 2;
  let marker = cutMarker(chars.length - 2 * keep);
  for (;;) {
    const next = Math.floor((VERBATIM_UTTERANCE_MAX_CHARS - Array.from(marker).length) / 2);
    if (next === keep) break;
    keep = next;
    marker = cutMarker(chars.length - 2 * keep);
  }
  return { cut: `${chars.slice(0, keep).join("")}${marker}${chars.slice(-keep).join("")}`, markerChars: Array.from(marker).length };
}

export function capVerbatimText(text: string): string {
  const length = Array.from(text).length;
  if (length <= VERBATIM_UTTERANCE_MAX_CHARS) return text;
  const { cut, markerChars } = verbatimMiddleCut(text);
  return length - Array.from(cut).length > markerChars ? cut : text;
}

export function splitVerbatimCuts(text: string): Array<string | { omitted: number }> {
  const parts: Array<string | { omitted: number }> = [];
  let from = 0;
  for (const match of text.matchAll(CUT_RE)) {
    parts.push(text.slice(from, match.index), { omitted: Number(match[1]) });
    from = match.index + match[0].length;
  }
  parts.push(text.slice(from));
  return parts;
}
