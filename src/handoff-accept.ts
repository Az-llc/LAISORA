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
// 受理下限。正常な compact 要約は標準 9 見出しがそろい数千字（実測 9/9・6,322 字）、拒否文は見出し 0・数百字（0/9・571 字）。
// 節の数と長さだけでは番号付きの長い拒否文が通るので、見出しは上の標準見出しとの一致で数える。
export const COMPACT_MIN_HEADINGS = 7;
export const COMPACT_MIN_BODY_CHARS = 1500;

// 上の 9 見出しは CLI 組み込みの compact プロンプトが持つ節指定で、LAISORA が要求した構造ではない。
// この引数は CLI 側で同じプロンプトへ追加指示として足されるだけなので、別の節構成を要求すると CLI の
// 節指定と競合する。型は**既存の見出しの中の行形式**として持たせる。
//
// 「各節の見出しは独立した行に置く」は必須。見出しと本文が 1 行に同居すると countCompactHeadings が
// その見出しを数え落とし、余裕は 9 − COMPACT_MIN_HEADINGS = 2 しか無い。行形式の項目を求める指示は
// 同居を誘発するため、明示的に打ち消す。
//
// `[GOAL]` 等のタグと引用符付きの節名は、どの言語バンドルでも同一の綴りにする（HV-01g）。CLI は本文を
// 会話の言語で書きながら節見出しは英語で固定するので、タグだけ翻訳されると生成物のタグが表示言語で割れる。
export const COMPACT_INSTRUCTION = {
  get text(): string {
    return l10n.t(
      "Summary for handoff. Keep the nine required sections and keep each section heading on a line of its own. Inside those sections carry state as tagged one-line entries rather than prose, one line per item, each line ending with src=user or src=assistant. Under \"Primary Request and Intent\": one [GOAL] line for each end state the user wants reached (the state itself, not the means to it) with its scope and whether it still holds, and one [KILLED] line for each thing the user rejected, naming what would let it be raised again. Under \"Pending Tasks\": one [DECIDED] line for each action that is settled but not yet carried out, and one [OPEN] line for each question that is still unsettled; include here the commitments you or an earlier assistant volunteered unasked and the user did not object to, and include items that carry no tracking ID. Under \"Problem Solving\": one [DROPPED] line for each claim later retracted or disproved, naming its current standing, because an entry without that reads as a permanent ban. Quote the user's statements verbatim without paraphrasing. If the conversation contains a <laisora-handoff> block, its decisions.entries already carry earlier [GOAL]/[KILLED]/[DECIDED]/[DROPPED] lines under ids such as D1. Do not rewrite a transcribed entry as a new tagged line. Write a new tagged line only for a decision that is not transcribed yet. When the status of a transcribed entry changed, write either [DROPPED] D7 … (the user retracted it) or, under \"Pending Tasks\", [DONE] D7 … (it was carried out, or the user said it is no longer wanted); put the id first on those lines and write them only when the user said so."
    );
  },
};

// 指示文が要求するタグ。指示文と検査（HV-01g）が同じ集合を見るための唯一の定義。**受理判定には
// 入れない**——本文にタグが載っていることは「受け手がそれを使う」の保証にならず、
// 受理を落とすと課金済みの compact ごと
// 複製を捨てるため、誤判定の代償が両方向で釣り合わない
export const COMPACT_ENTRY_TAGS: readonly string[] = Object.freeze([
  "[GOAL]",
  "[KILLED]",
  "[DECIDED]",
  "[OPEN]",
  "[DROPPED]",
  "[DONE]",
]);

// 次世代へ機械転記するタグ（R-HND-11）。`[OPEN]` は入れない（未決は次世代で問い直される）
export const DECISION_TAGS: readonly string[] = Object.freeze(["GOAL", "KILLED", "DECIDED", "DROPPED"]);
// 利用者が「済んだ / 要らない」と言ったときだけ書かれる。転記済みエントリを外す唯一の入口
export const DECISION_DONE_TAG = "DONE";

export type DecisionTag = "GOAL" | "KILLED" | "DECIDED" | "DROPPED";

export interface ExtractedDecisionLine {
  t: DecisionTag | "DONE";
  // タグと（名指しがあれば）ID を除いた本文。空白正規化だけで原文を書き換えない
  s: string;
  id?: string;
}

// 行頭の番号・見出し記号・箇条書き・強調を剥がす。countCompactHeadings と extractDecisionLines が
// 同じ規則を見るための唯一の定義（別実装にすると片方だけ直り、見出しと決定行で拾える形が食い違う）
export function normalizeSummaryLine(line: string): string {
  return line.trim().replace(/^(?:\d+[.)]\s*|#{1,6}\s*|[-*+]\s*|\*\*|__)+/, "");
}

// ``` と ~~~ の両方をフェンスとして扱い、開いた記号と同じ記号でだけ閉じる。
// 片方しか見ないと、もう片方のフェンスに囲まれた見出し・タグ行を本文として拾う。
// 返り値が true の行は「フェンスの印か、フェンスの内側」で、呼び出し側は読み飛ばす
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

// `D1` / `D-1` / `d1` / `D 1` / `#D1` を同一視する（R-HND-11）
const DECISION_ID_RE = /^[#\s]*[Dd][-\s]?(\d+)/;

export function normalizeDecisionId(text: string): { id: string; rest: string } | null {
  const m = DECISION_ID_RE.exec(text);
  return m === null ? null : { id: `D${Number(m[1])}`, rest: text.slice(m[0].length) };
}

// 受理済みの要約本文からタグ行を拾う。**節は見ない**: 見出しと本文の同居で見出しが数え落ちるのは
// 既知の外部制約で、節で門を作ると落ちた節の決定行が黙って消える。過剰取得より黙った欠落を避ける
export function extractDecisionLines(body: string): ExtractedDecisionLine[] {
  const out: ExtractedDecisionLine[] = [];
  const fenced = createFenceTracker();
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (fenced(raw)) continue;
    const line = normalizeSummaryLine(raw);
    const tag = [...DECISION_TAGS, DECISION_DONE_TAG].find((candidate) => line.startsWith(`[${candidate}]`));
    if (tag === undefined) continue;
    // タグを囲んだ強調（`**[GOAL]**`）の閉じだけを剥がす。残すと本文の先頭に markup が混ざり、
    // 世代をまたぐ完全一致の重複排除が同じ決定を取り逃す
    const rest = line.slice(tag.length + 2).replace(/^(?:\*\*|__)/, "");
    // ID の名指しは状態変更（DROPPED / DONE）だけが持つ。他のタグで剥がすと本文が書き換わる
    const ref = tag === "DROPPED" || tag === DECISION_DONE_TAG ? normalizeDecisionId(rest) : null;
    out.push({
      t: tag as DecisionTag | "DONE",
      ...(ref === null ? {} : { id: ref.id }),
      s: (ref === null ? rest : ref.rest).replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

// 転記行を読むモデルへの前置き。封筒 JSON へ永続するので l10n を通さず、値は sha256 で固定する。
// ENVELOPE_PREAMBLE とは別の定数にする（同じ値にすると既存封筒の一致検査が巻き添えで壊れる）
export const DECISIONS_PREAMBLE =
  "The following entries were transcribed mechanically from the tagged lines of earlier summaries in this handoff chain; they were not re-summarized. A larger g means a more recent generation. For what a decision says, these transcribed lines are authoritative because they stay close to the original wording. For the current status of a decision (effective / retracted / already done), the explicit tags in the preceding summary are authoritative. Differences in wording are not contradictions: the same matter described in other words is not a conflict, so do not report it. Ask the user only when two statements about the same id collide head-on, such as the same id being named both effective and retracted. Do not rewrite these entries as new tagged lines; to change the status of an entry, name its id.";

// 封筒 JSON の `preamble` として記録へ永続し、読み直しはこの値との完全一致で判定される
// （R-HND-04。`handoff-envelope.ts#parseV2`）。表示文言ではなく記録上のトークンなので
// l10n.t を通さない。表示言語や文面の変更で値が変わると、それまでに書かれた封筒が `schema_mismatch` に
// なり、世代境界の検出（`session-transcript.ts#verbatimGenerationStart`）と引き継ぎ由来レコードの
// 除外（R-HND-06）が同時に壊れる
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
  // R-HND-03: 構造タグの閉鎖を検査する。本文中でタグ名を説明した文字列は未閉鎖に数えない。
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

  // 本文先頭の、独立行になっていない <analysis> も除去し、閉鎖がなければ拒否する。
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
    // 接頭辞は重なる（CLI の要約見出しは `## 1. Primary Request and Intent` の形）。
    // 番号・#・箇条書き・強調を全部剥がしてから照合する
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
