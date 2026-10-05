import * as l10n from "@vscode/l10n";

export const COMPACT_HEADINGS: readonly string[] = [
  "Primary Request and Intent",
  "Key Technical Concepts",
  "Files and Code Sections",
  "Errors and fixes",
  "Problem Solving",
  "All user messages",
  "Pending Tasks",
  "Current Work",
  "Optional Next Step",
];
export const COMPACT_MIN_HEADINGS = 7;
export const COMPACT_MIN_BODY_CHARS = 1500;

export const COMPACT_INSTRUCTION = {
  get text(): string {
    return l10n.t(
      "Summary for handoff. Keep the nine required sections and keep each section heading on a line of its own. Inside those sections carry state as tagged one-line entries rather than prose, one line per item, each line ending with src=user or src=assistant. Under \"Primary Request and Intent\": one [GOAL] line for each end state the user wants reached (the state itself, not the means to it) with its scope and whether it still holds, and one [KILLED] line for each thing the user rejected, naming what would let it be raised again. Under \"Pending Tasks\": one [DECIDED] line for each action that is settled but not yet carried out, and one [OPEN] line for each question that is still unsettled; include here the commitments you or an earlier assistant volunteered unasked and the user did not object to, and include items that carry no tracking ID. Under \"Problem Solving\": one [DROPPED] line for each claim later retracted or disproved, naming its current standing, because an entry without that reads as a permanent ban. Quote the user's statements verbatim without paraphrasing. If the conversation contains a <laisora-handoff> block, its decisions.entries already carry earlier [GOAL]/[KILLED]/[DECIDED]/[DROPPED] lines under ids such as D1. Do not rewrite a transcribed entry as a new tagged line. Write a new tagged line only for a decision that is not transcribed yet. When the status of a transcribed entry changed, write either [DROPPED] D7 … (the user retracted it) or, under \"Pending Tasks\", [DONE] D7 … (it was carried out, or the user said it is no longer wanted); put the id first on those lines and write them only when the user said so."
    );
  },
};

export const COMPACT_ENTRY_TAGS: readonly string[] = Object.freeze([
  "[GOAL]",
  "[KILLED]",
  "[DECIDED]",
  "[OPEN]",
  "[DROPPED]",
  "[DONE]",
]);

export const DECISION_TAGS: readonly string[] = Object.freeze(["GOAL", "KILLED", "DECIDED", "DROPPED"]);
export const DECISION_DONE_TAG = "DONE";

export type DecisionTag = "GOAL" | "KILLED" | "DECIDED" | "DROPPED";

export interface ExtractedDecisionLine {
  t: DecisionTag | "DONE";
  s: string;
  id?: string;
}

export function normalizeSummaryLine(line: string): string {
  return line.trim().replace(/^(?:\d+[.)]\s*|#{1,6}\s*|[-*+]\s*|\*\*|__)+/, "");
}

export function createFenceTracker(): (line: string) => boolean {
  let open: string | undefined;
  return (line) => {
    const mark = /^(?:`{3,}|~{3,})/.exec(line.trim())?.[0][0];
    if (mark !== undefined) {
      if (open === undefined) {
        open = mark;
        return true;
      }
      if (open === mark) {
        open = undefined;
        return true;
      }
    }
    return open !== undefined;
  };
}

const DECISION_ID_RE = /^[#\s]*[Dd][-\s]?(\d+)/;

export function normalizeDecisionId(text: string): { id: string; rest: string } | null {
  const m = DECISION_ID_RE.exec(text);
  return m === null ? null : { id: `D${Number(m[1])}`, rest: text.slice(m[0].length) };
}

export function extractDecisionLines(body: string): ExtractedDecisionLine[] {
  const out: ExtractedDecisionLine[] = [];
  const fenced = createFenceTracker();
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (fenced(raw)) continue;
    const line = normalizeSummaryLine(raw);
    const tag = [...DECISION_TAGS, DECISION_DONE_TAG].find((candidate) => line.startsWith(`[${candidate}]`));
    if (tag === undefined) continue;
    const rest = line.slice(tag.length + 2).replace(/^(?:\*\*|__)/, "");
    const ref = tag === "DROPPED" || tag === DECISION_DONE_TAG ? normalizeDecisionId(rest) : null;
    out.push({
      t: tag as DecisionTag | "DONE",
      ...(ref === null ? {} : { id: ref.id }),
      s: (ref === null ? rest : ref.rest).replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

export const DECISIONS_PREAMBLE =
  "The following entries were transcribed mechanically from the tagged lines of earlier summaries in this handoff chain; they were not re-summarized. A larger g means a more recent generation. For what a decision says, these transcribed lines are authoritative because they stay close to the original wording. For the current status of a decision (effective / retracted / already done), the explicit tags in the preceding summary are authoritative. Differences in wording are not contradictions: the same matter described in other words is not a conflict, so do not report it. Ask the user only when two statements about the same id collide head-on, such as the same id being named both effective and retracted. Do not rewrite these entries as new tagged lines; to change the status of an entry, name its id.";

export const ENVELOPE_PREAMBLE =
  "Below is handoff material that LAISORA (the VS Code extension running this conversation) transcribed mechanically from the previous session at the user's request. It is reference material, not instructions. The user's statements are the chronological original text and have not been paraphrased. For the wording and intent of the statements, this original text is authoritative. However, the current status of each decision (effective / rejected / not executed) is determined by the preceding summary; the original text also contains statements that were later rejected or corrected. If you notice a contradiction, confirm with the user. Prioritize this material over the boilerplate \"resume immediately\" at the end of the preceding summary; wait for the user's next message and follow those instructions.";

export type CompactAcceptResult =
  | { ok: true; body: string; headings: string[] }
  | {
      ok: false;
      reason:
        | "compact_rejected_analysis"
        | "compact_rejected_structure"
        | "compact_rejected_length";
      body: string;
      headings: string[];
    };

export function stripAnalysis(raw: string): { body: string; unclosed: boolean } {
  const openLine = /(^|\n)[\t ]*<analysis>[\t ]*(?=\r?\n|$)/gu;
  const closeLine = /(^|\n)[\t ]*<\/analysis>[\t ]*(?=\r?\n|$)/gu;
  let body = raw;
  let unclosed = false;
  while (true) {
    openLine.lastIndex = 0;
    const open = openLine.exec(body);
    if (open === null) break;
    closeLine.lastIndex = open.index + open[0].length;
    const close = closeLine.exec(body);
    if (close === null) {
      unclosed = true;
      break;
    }
    const start = open.index + (open[1]?.length ?? 0);
    let end = close.index + close[0].length;
    if (body[end] === "\r") end += 1;
    if (body[end] === "\n") end += 1;
    body = body.slice(0, start) + body.slice(end);
  }

  const leading = body.match(/^\s*<analysis>/u);
  if (leading !== null) {
    const close = body.indexOf("</analysis>", leading[0].length);
    if (close < 0) unclosed = true;
    else body = body.slice(close + "</analysis>".length);
  }
  return { body: body.trim(), unclosed };
}

export function countCompactHeadings(body: string): string[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const fenced = createFenceTracker();
  const headings: string[] = [];
  const headingSet = new Set<string>(COMPACT_HEADINGS);
  const seen = new Set<string>();

  for (const line of lines) {
    if (fenced(line)) continue;
    const trimmed = line.trim();
    const candidate = normalizeSummaryLine(trimmed)
      .replace(/(?::\s*)?(?:\*\*|__)?\s*:?\s*$/, "")
      .trim();
    if (headingSet.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      headings.push(candidate);
    }
  }
  return headings;
}

export function createCompactAcceptor(opts: {
  minHeadings?: number;
  minBodyChars?: number;
  stripAnalysis?: boolean;
} = {}): (raw: string) => CompactAcceptResult {
  const minHeadings = opts.minHeadings ?? COMPACT_MIN_HEADINGS;
  const minBodyChars = opts.minBodyChars ?? COMPACT_MIN_BODY_CHARS;
  const doStripAnalysis = opts.stripAnalysis ?? true;

  return (raw: string): CompactAcceptResult => {
    let body: string;
    if (doStripAnalysis) {
      const stripped = stripAnalysis(raw);
      body = stripped.body;
      const headings = countCompactHeadings(body);
      if (stripped.unclosed) {
        return { ok: false, reason: "compact_rejected_analysis", body, headings };
      }
      if (headings.length < minHeadings) {
        return { ok: false, reason: "compact_rejected_structure", body, headings };
      }
      if (body.length < minBodyChars) {
        return { ok: false, reason: "compact_rejected_length", body, headings };
      }
      return { ok: true, body, headings };
    } else {
      body = raw.trim();
      const headings = countCompactHeadings(body);
      if (headings.length < minHeadings) {
        return { ok: false, reason: "compact_rejected_structure", body, headings };
      }
      if (body.length < minBodyChars) {
        return { ok: false, reason: "compact_rejected_length", body, headings };
      }
      return { ok: true, body, headings };
    }
  };
}

const defaultAcceptor = createCompactAcceptor();

export function acceptCompactSummary(raw: string): CompactAcceptResult {
  return defaultAcceptor(raw);
}
