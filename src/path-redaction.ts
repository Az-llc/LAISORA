// Webview へ渡すプレビュー文字列から絶対パス（canonical path）を落とす
// （NormalizedEvent の JSON にどのフィールドからも canonical path を出さない）。
// パスの同一性は artifacts[].artifactId が運ぶため、表示は basename で足りる（P0-H）。
// 入力は JSON.stringify 済み文字列と生文字列の両方。JSON 形では実バックスラッシュ 1 本が `\\` 2 文字、
// UNC（実 2 本）は 4 文字で現れる。
// `//` もドライブ区切りとして許すが、https://… の s: は URL スキームの一部なので除く。
// JSON エスケープ直後（"paths:\nC://Users/…" の n）はドライブとして扱う。
// トークン本体は `\"`（JSON エスケープ済み引用符）と `<` で止める。止めないと閉じ引用符のエスケープを
// 食って JSON を壊し（`cd \"C:/x\" && ls` → `cd \"x" && ls`）、`C:\…\project</tool_use_error>` の
// basename が `tool_use_error>` になる。

const WIN_ABS = /[A-Za-z]:(?:\\+|\/(?!\/)|(?<![A-Za-z0-9+.-][A-Za-z]:)\/+|(?<=\\[nrt][A-Za-z]:)\/+)(?:[^\s"'`|;)\]}>\\<]|\\(?!"))*/g;
// JSON 形の相対パス `scripts\\build.py` は `\\` の直前が名前文字。UNC はトークン先頭（直前が境界文字）か
// JSON 形の 4 本以上だけ。境界に非 ASCII を入れると `資料（d）\\a.txt` 型の相対パスが潰れる。
const UNC = /(?:(?<=^|[\s"'`=(\[{,:;<>|])\\{2,}|\\{4,})(?:[^\s"'`|;)\]}>\\<]|\\(?!"))+/g;
const FILE_URI = /file:\/\/(?:[^\s"'`|;)\]}>\\<]|\\(?!"))+/gi;
// /dev /proc /sys は擬似 FS で利用者のパスを含まない。`/dev/null` を `null` に潰すとシェル系の失敗を
// LLM が帰属できない。
// 名前文字・相対パスの接頭辞以外を境界にする。-I/path のフラグ部分も境界として扱う。
// `<` も境界だが、`.` を含まない閉じタグ `</name>` は除く。`</key.pem>` はパスとして落とす
// （verify-analysis-persistence#P-22）。
const POSIX_ABS = /(?<=^|[^\p{L}\p{N}\p{M}_./\\~%+-]|\\[nrt]|(?:^|[^\p{L}\p{N}\p{M}_./\\~%+-])-[A-Za-z])(?!(?<=<)\/[A-Za-z][\w:-]*>)(?!(?<=(?<!\\)[A-Za-z0-9+.-]:)\/\/)\/+(?!(?:dev|proc|sys)\/)[^\s"'`|;)\]}>\\<]+/gu;

function basenameOf(token: string): string {
  const parts = token.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

// producer（redactAbsolutePaths）と consumer（Handoff の最終検証）が別 regex を持つと、
// consumer が producer より弱くなり fail-closed が逆転する。判定器はこの1つを共有する
// g フラグ付き regex の test は lastIndex を持ち越して次回結果を狂わせるため、
// 判定は replace の結果比較で行う（状態を持たない）
export function containsAbsolutePath(text: string): boolean {
  return redactAbsolutePaths(text) !== text;
}

export function redactAbsolutePaths(text: string): string {
  return text
    .replace(FILE_URI, (m) => basenameOf(m))
    .replace(WIN_ABS, (m) => basenameOf(m))
    .replace(UNC, (m) => basenameOf(m))
    .replace(POSIX_ABS, (m) => basenameOf(m));
}

export function redactOptional(text: string | undefined): string | undefined {
  return text === undefined ? undefined : redactAbsolutePaths(text);
}
