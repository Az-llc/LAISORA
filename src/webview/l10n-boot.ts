// scripts/esbuild.mjs の webview ビルドが inject でこのモジュールを全入力へ差し込む。dom.ts の chrome
// テンプレートと menu.ts のモジュール定数は**モジュール評価時**に l10n.t() を呼ぶので、init
// メッセージ受信後に設定しても間に合わない。import 元より依存先が先に評価される規則だけが
// 順序を保証しているため、ここから他の webview モジュールを import しない。
import { configureWebviewL10n } from "./l10n";

// esbuild の define が l10n/bundle.l10n.ja.json（空白を除いた JSON）へ置換する
declare const __LAISORA_L10N_JA_BUNDLE__: string;

// 言語の正本は document.documentElement.lang（Host が vscode.env.language をそこへ出す）。
// 未知の言語は空バンドル = キーそのもの = 英語
export function selectWebviewL10nBundle(lang: string): Record<string, string> {
  if (!lang.toLowerCase().startsWith("ja")) return {};
  return JSON.parse(__LAISORA_L10N_JA_BUNDLE__) as Record<string, string>;
}

configureWebviewL10n(selectWebviewL10nBundle(document.documentElement.lang));
