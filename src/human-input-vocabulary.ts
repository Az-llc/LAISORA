// provider transcript の user レコード語彙。history・live・analysis.ts の各経路が同じ表を見る。
// 経路ごとに別の判定を作らない。
// extractHumanUserText の本体はこのモジュールではなく session-transcript.ts にあり、
// analysis.ts はそちらを import する。joinTextBlocks（フィルタしない全結合）と
// session-transcript.ts の extractText（`<system-reminder>` / `<ide_` を落とす）は
// 別物のまま — gap 境界判定は前者、人間発言判定は後者を使う。

// laisora-handoff は LAISORA 自身が注入する引き継ぎ封筒。
// この allowlist は「非人間発話か」と「gap 境界か」だけを決める prefix 判定であり、
// 信頼済み Handoff の判定は handoff-envelope.ts が別に行う。
// laisora-steer は Live Guardrail の steering envelope。
// **同じ正規表現が session-display-title.ts にも複製されている**（あちらは command-args を
// 足した別物）。片方だけ更新すると経路ごとに判定が割れる（セッション一覧のタイトルに
// 封筒が出る）。2 複製の同一性は GR-19 が文字列比較で固定し、
// extension.ts に複製を再導入しないことも同じ検査が見る
export const INJECTED_TAG_RE =
  /^<\/?(?:laisora-handoff|laisora-steer|command-message|command-name|local-command-[a-z-]+|system-reminder|task-notification)[\s>]/i;
// steering envelope の prefix 述語。非人間（上の allowlist に含む）だが gap 境界にはしない:
// live 側に境界を渡す側チャネルが無く、実測では
// tool_result 境界か次ターン先頭で消費されモデルの停止区間を作らない
export const STEER_TAG_RE = /^<\/?laisora-steer[\s>]/i;
// LAISORA 発 envelope（handoff / steer）。extractHumanUserText はこれに一致したら command-args 抽出へ
// 進まず即 null にする（無アンカーの COMMAND_ARGS_RE が envelope 本文中の <command-args> を拾う穴を塞ぐ）
export const LAISORA_ENVELOPE_RE = /^<\/?laisora-(?:handoff|steer)[\s>]/i;
export const COMMAND_ARGS_RE = /<command-args\b[^>]*>([\s\S]*?)<\/command-args>/i;
export const COMMAND_NAME_RE = /<command-name\b[^>]*>\s*\/?([^<\s]+)/i;
export const PURE_COMMAND_WRAPPER_RE = new RegExp(
  "^/(?:model|effort|color|clear|compact|context|help|init|login|logout|memory|permissions|" +
    "plan|resume|status|terminal-setup|vim|voice)\\s*$",
  "i"
);

// 引数を取るが人間発話ではないコマンド。PURE_COMMAND_WRAPPER_RE は末尾 `\s*$` を要求するので
// 引数付きコマンドを捕まえられず、この表と使い分ける必要がある。
// 実測（2026-08-18）で /rename の user レコードは `<command-args>` を持つ。
// この表に無いと extractHumanUserText がその引数を人間発話として返す。
// 一般化しない: 他コマンドは実ログのレコード構造を確認してから足す
const NON_HUMAN_COMMAND_NAMES = new Set(["rename"]);

const RAW_COMMAND_NAME_RE = /^\/([^\s]+)/;

// 呼び出し側が「このレコードは注入ラッパである」と確定したあとに、抽出済みの名前だけを渡すこと。
// COMMAND_NAME_RE は無アンカーなので、本文へ transcript を貼り付けただけの実発話まで
// 巻き込む（INJECTED_TAG_RE を allowlist にしてある理由と同じ失敗）
export function isNonHumanCommandName(name: string | undefined): boolean {
  return name !== undefined && NON_HUMAN_COMMAND_NAMES.has(name.toLowerCase());
}

// live 入力欄の生テキスト（`/rename stage4,5`）用。先頭のコマンド名だけを見る。
// history 側の正規化境界（session-transcript.extractHumanUserText）と同じ表を
// 共有しないと、live だけイベントが生まれて segment 採番が経路で割れる
export function isNonHumanCommandInput(text: string): boolean {
  return isNonHumanCommandName(RAW_COMMAND_NAME_RE.exec(text.trim())?.[1]);
}

// フィルタしない全結合。
// gap 境界判定は「注入レコードかどうか」を見るので、`<system-reminder>` を
// 落とす extractText 系ではなくこちらを入力にする
export function joinTextBlocks(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// longGap を切る3分岐のうち hasToolResult 以外の2つ。
// 該当レコードはモデルが動いていた区間ではないので longGap の境界になる
// （承認待ち等は除外し、「待ち時間」と呼ばない）。hasToolResult 分岐は
// L1.5 の tool_call_finished がそのまま境界になるためここには無い
// NON_HUMAN_COMMAND_NAMES を境界からも抜くのは、境界が semanticHash の入力
// （semantic-model の longGaps 射影）だから。境界にすると /rename レコードの有無で
// longGap が割れて hash が動き、「レコードが無いログと同一」という不変条件を満たせない
export function isGapBoundaryText(text: string): boolean {
  if (text === "") return false;
  if (STEER_TAG_RE.test(text)) return false;
  if (INJECTED_TAG_RE.test(text)) {
    return !isNonHumanCommandName(COMMAND_NAME_RE.exec(text)?.[1]);
  }
  return PURE_COMMAND_WRAPPER_RE.test(text);
}

// live の user_message は LAISORA の入力欄の生テキストで、`/model` のような
// 引数なしコマンドも人間発言として届く。history 側は extractHumanUserText が
// これを落としてイベントを作らないため、走査では両経路とも境界として扱う
export function isPureCommandWrapper(text: string): boolean {
  return PURE_COMMAND_WRAPPER_RE.test(text.trim());
}
