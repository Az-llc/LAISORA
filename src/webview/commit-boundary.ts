// CommonMark 4.5: 閉じフェンスは開きと同じ文字で、開きの長さ以上、info 文字列なし。
// 文字と長さを見ないと ``` の内側の ~~~ や短い ``` で閉じたと誤認し、
// 続く行（参照定義など）が別 chunk へ確定されて表示から消える（Sol S-1 で実証）
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

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
      } else if (run[0] === fence.char && run.length >= fence.len && rest.trim() === "") {
        fence = null;
      }
    }
    pos += line.length + 1;
    if (fence === null && line.trim() === "" && pos > committedLen) boundary = pos;
  }
  return boundary >= buf.length ? -1 : boundary;
}
