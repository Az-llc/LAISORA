// タブ上限と、そこから導出する履歴 scope 上限。vscode / SDK に依存しない純関数だけを置く。
// モジュールレベルの可変状態を持たせないこと（entry ごとに別の写しができる）。
//
// 導出式をこの 1 箇所に閉じる。scope 上限を固定値へ戻すと、タブ上限を上げた瞬間に
// 生きているタブの scope が退避され、そのタブだけ遡れなくなる（R-SES-04）。
// 再現条件がタブ数依存で、最古のタブでしか出ないため単体では気づけない。
export const TAB_LIMIT_DEFAULT = 20;
// package.json の contributes（laisora.tabLimit.minimum）と対の有効範囲の下端。
// 片方だけ動かすと設定 UI が通す値をコードが弾く（W-18 が一致を固定）
export const TAB_LIMIT_MIN = 1;
export const SCOPE_MAX_PER_TAB = 2;

// 設定として成立しない値（非数・範囲外）は全て既定へ落とす（R-SES-03「既定は 20」）。
// 範囲外を下限クランプにしてはいけない: Number("") === 0 なので "" / " " / "0" だけが
// 1 になり、他の不正値（"abc" → NaN → 20）と挙動が割れる
export function resolveTabLimit(value: unknown, fallback: number = TAB_LIMIT_DEFAULT): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const truncated = Math.trunc(n);
  if (truncated < TAB_LIMIT_MIN) return fallback;
  return truncated;
}

export function scopeMaxForTabs(tabLimit: number, openTabCount: number): number {
  // 上限を下げてもタブは閉じない。開いているタブ数を下回らせない（R-SES-04）
  return Math.max(tabLimit, openTabCount) * SCOPE_MAX_PER_TAB;
}
