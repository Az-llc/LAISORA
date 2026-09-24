import { basename, dirname, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

// 保存先配下かの判定はこの 2 本だけ。extension.ts の isInSessionStore も同じ 2 本を通す
// （resolve だけの前方一致を別に持つと、ジャンクション経由の脱出が片方だけ通る）。
// 最終許可判定では両辺を realPathOrNearestSync に通すこと。candidate I/O 前の棄却に限り
// lexical path へ使えるが、true を許可根拠にしてはならない。resolve は `..` しか畳まず、
// リンクの実体も Windows の大小差も残る
export function pathIsInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + sep);
}

// realpath は存在しないパスで ENOENT を投げる。書く前の検査・同期途中の欠落でも判定を続けられる
// よう、実在する最も近い祖先まで遡って実体を採り、残りを継ぎ足す（残りは実在しないので
// リンクではありえず、継ぎ足しても脱出経路にならない）。ENOENT / ENOTDIR 以外は
// 「確かめられなかった」なので null を返して呼び手に閉じさせる。
// Google Drive 同期下では実体が入れ替わりうるので結果をキャッシュしない
export function realPathOrNearestSync(target: string): string | null {
  let current = resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.push(basename(current));
      current = parent;
    }
  }
}
