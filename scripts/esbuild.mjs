// The Agent SDK is bundled so the VSIX is self-contained and does not rely on
// a separately installed SDK. Keep import.meta.url mapped to the CJS entry: it
// repairs the SDK's two import.meta.url call sites after bundling.
// Reconsider this when upgrading the SDK, or when we intentionally ship the
// SDK as an external runtime dependency: verify its import.meta.url usage,
// optional-native-CLI discovery, and that both extension and test-harness
// builds still load correctly before removing this transform.

import * as esbuild from "esbuild";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";

// 公開ツリーには src/test/ が無い。無いときは harness を作らず、前回のビルドが残した出力を消す
// （残すと dist を読む検査が今の src と対応しない harness を読む）
const HARNESS_ENTRY = "src/test/harness.ts";
if (!existsSync(HARNESS_ENTRY)) {
  rmSync("dist/test-harness.js", { force: true });
  rmSync("dist/test-harness.js.map", { force: true });
}

const sdkPackage = JSON.parse(readFileSync("node_modules/@anthropic-ai/claude-agent-sdk/package.json", "utf8"));
const sdkClaudeCodeVersion = typeof sdkPackage.claudeCodeVersion === "string" ? sdkPackage.claudeCodeVersion : undefined;

const watch = process.argv.includes("--watch");

// webview は Host から bundle を受け取れない（受信は最初の t() より後）。ビルド時に ja バンドルを
// 埋め、src/webview/l10n-boot.ts が言語で選ぶ。空白を除くのは配布物の増分を抑えるため
const jaL10nBundleLiteral = JSON.stringify(
  JSON.stringify(JSON.parse(readFileSync("l10n/bundle.l10n.ja.json", "utf8")))
);

// ESM 出力で @vscode/l10n（CJS main.js）の require("fs") が Dynamic require になり落ちるので、node 向け ESM には require を先頭で与える
const ESM_NODE_BANNER = { js: 'import { createRequire as __l10nCreateRequire } from "node:module"; const require = __l10nCreateRequire(import.meta.url);' };

const extensionCtx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: {
    "import.meta.url": "__laisoraImportMetaUrl",
    "__LAISORA_SDK_CLAUDE_CODE_VERSION__": JSON.stringify(sdkClaudeCodeVersion),
  },
  banner: { js: '"use strict"; const __laisoraImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  outfile: "dist/extension.js",
  external: ["vscode"],
  // map を出さない。理由は 2 つで、どちらも「出しても使えない」。
  // (1) `.map` は配布物に含めない方針なので、出すと配布された bundle の
  //     `//# sourceMappingURL=` が必ず存在しないファイルを指す（VSIX 検査はこれを
  //     SOURCEMAP-REFERENCE として記録するだけで落としはしない。落ちるのは INLINE-SOURCEMAP）。
  // (2) このファイルはビルド後に @ を `\x40` へ書き換える（末尾の sanitize）。1 文字が 4 文字になるので
  //     置換より後ろの桁が全てずれ、出しても内容が合わない map になる。
  // map を復活させるなら先に sanitize を esbuild の変換内へ移すこと。test-harness は配布も sanitize もしないので true のまま
  sourcemap: false,
  metafile: true,
  logLevel: "info",
});

const harnessCtx = existsSync(HARNESS_ENTRY) ? await esbuild.context({
  entryPoints: [HARNESS_ENTRY],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: {
    "import.meta.url": "__laisoraImportMetaUrl",
    "__LAISORA_SDK_CLAUDE_CODE_VERSION__": JSON.stringify(sdkClaudeCodeVersion),
  },
  banner: { js: '"use strict"; const __laisoraImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  outfile: "dist/test-harness.js",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
}) : undefined;

const webviewCtx = await esbuild.context({
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  // inject は全入力へ差し込まれ、差し込み先より前に評価される。dom.ts / menu.ts が
  // モジュール評価時に l10n.t() を呼ぶため、この順序が日本語表示の前提になっている
  inject: ["src/webview/l10n-boot.ts"],
  define: { "__LAISORA_L10N_JA_BUNDLE__": jaL10nBundleLiteral },
  outfile: "dist/webview.js",
  sourcemap: false,
  metafile: true,
  logLevel: "info",
});

const settingsPageCtx = await esbuild.context({
  entryPoints: ["src/webview/settings-page.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  inject: ["src/webview/l10n-boot.ts"],
  define: { "__LAISORA_L10N_JA_BUNDLE__": jaL10nBundleLiteral },
  outfile: "dist/settings.js",
  sourcemap: false,
  metafile: true,
  logLevel: "info",
});

const workModelCtx = await esbuild.context({
  entryPoints: ["src/work-model.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/work-model.mjs",
  sourcemap: false,
  logLevel: "info",
});
const eventWindowCtx = await esbuild.context({
  entryPoints: ["src/event-window.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/event-window.mjs",
  sourcemap: false,
  logLevel: "info",
});
const historyWindowCtx = await esbuild.context({
  entryPoints: ["src/history-window.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/history-window.mjs",
  sourcemap: false,
  logLevel: "info",
});
const conversationHistoryCtx = await esbuild.context({
  entryPoints: ["src/conversation-history.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/conversation-history.mjs",
  sourcemap: false,
  logLevel: "info",
});
const progressProtocolCtx = await esbuild.context({
  entryPoints: ["src/progress-protocol.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/progress-protocol.mjs",
  sourcemap: false,
  logLevel: "info",
});
const llmReportCtx = await esbuild.context({
  entryPoints: ["src/llm-report.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/llm-report.mjs",
  sourcemap: false,
  logLevel: "info",
});
const projectionCtx = await esbuild.context({
  entryPoints: ["src/projection.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/projection.mjs",
  sourcemap: false,
  logLevel: "info",
});
const handoffEnvelopeCtx = await esbuild.context({
  entryPoints: ["src/handoff-envelope.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/handoff-envelope.mjs",
  sourcemap: false,
  logLevel: "info",
});
const handoffAcceptCtx = await esbuild.context({
  entryPoints: ["src/handoff-accept.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/handoff-accept.mjs",
  sourcemap: false,
  logLevel: "info",
});
const handoffRunnerCtx = await esbuild.context({
  entryPoints: ["src/handoff-runner.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/handoff-runner.mjs",
  sourcemap: false,
  logLevel: "info",
});
const observedSeedCtx = await esbuild.context({
  entryPoints: ["src/observed-timestamp-seed.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/observed-timestamp-seed.mjs",
  sourcemap: false,
  logLevel: "info",
});
const sendBoundaryCtx = await esbuild.context({
  entryPoints: ["src/send-boundary.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/send-boundary.mjs",
  sourcemap: false,
  logLevel: "info",
});
const humanVocabCtx = await esbuild.context({
  entryPoints: ["src/human-input-vocabulary.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/human-input-vocabulary.mjs",
  sourcemap: false,
  logLevel: "info",
});
const handoffCapsuleCtx = await esbuild.context({
  entryPoints: ["src/handoff-capsule.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/handoff-capsule.mjs",
  sourcemap: false,
  logLevel: "info",
});


const artifactAccessCtx = await esbuild.context({
  entryPoints: ["src/artifact-access.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/artifact-access.mjs",
  sourcemap: false,
  logLevel: "info",
});
const toolObservationCtx = await esbuild.context({
  entryPoints: ["src/tool-observation.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/tool-observation.mjs",
  sourcemap: false,
  logLevel: "info",
});
const protocolCtx = await esbuild.context({
  entryPoints: ["src/protocol.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/protocol.mjs",
  sourcemap: false,
  logLevel: "info",
});
const evidenceIndexCtx = await esbuild.context({
  entryPoints: ["src/evidence-index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/evidence-index.mjs",
  sourcemap: false,
  logLevel: "info",
});
const claudeNormalizerCtx = await esbuild.context({
  entryPoints: ["src/claude-normalizer.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/claude-normalizer.mjs",
  external: ["vscode"],
  sourcemap: false,
  logLevel: "info",
});
const semanticModelCtx = await esbuild.context({
  entryPoints: ["src/semantic-model.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/semantic-model.mjs",
  sourcemap: false,
  logLevel: "info",
});
const sessionTranscriptCtx = await esbuild.context({
  entryPoints: ["src/session-transcript.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/session-transcript.mjs",
  external: ["vscode"],
  sourcemap: false,
  logLevel: "info",
});
// dist/l3-analysis.mjs は検査が読む。src と同じビルドで毎回作り直す（古いままだと検査が古い実装を検証する）
const l3AnalysisCtx = await esbuild.context({
  entryPoints: ["src/l3-analysis.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/l3-analysis.mjs",
  sourcemap: false,
  logLevel: "info",
});
const l3DivergenceCtx = await esbuild.context({
  entryPoints: ["src/l3-divergence.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/l3-divergence.mjs",
  sourcemap: false,
  logLevel: "info",
});
const steeringEnvelopeCtx = await esbuild.context({
  entryPoints: ["src/steering-envelope.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/steering-envelope.mjs",
  sourcemap: false,
  logLevel: "info",
});
const sessionDisplayTitleCtx = await esbuild.context({
  entryPoints: ["src/session-display-title.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/session-display-title.mjs",
  sourcemap: false,
  logLevel: "info",
});
const guardrailCtx = await esbuild.context({
  entryPoints: ["src/guardrail.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/guardrail.mjs",
  sourcemap: false,
  logLevel: "info",
});
const llmCitationAliasCtx = await esbuild.context({
  entryPoints: ["src/llm-citation-alias.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/llm-citation-alias.mjs",
  sourcemap: false,
  logLevel: "info",
});
const llmFindingVerifyCtx = await esbuild.context({
  entryPoints: ["src/llm-finding-verify.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/llm-finding-verify.mjs",
  sourcemap: false,
  logLevel: "info",
});
const llmAnalysisClientCtx = await esbuild.context({
  entryPoints: ["src/llm-analysis-client.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/llm-analysis-client.mjs",
  sourcemap: false,
  logLevel: "info",
});
const llmAnalysisPromptCtx = await esbuild.context({
  entryPoints: ["src/llm-analysis-prompt.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/llm-analysis-prompt.mjs",
  sourcemap: false,
  logLevel: "info",
});
const llmAnalysisSdkClientCtx = await esbuild.context({
  entryPoints: ["src/llm-analysis-sdk-client.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/llm-analysis-sdk-client.mjs",
  sourcemap: false,
  logLevel: "info",
});
const llmActionPolicyCtx = await esbuild.context({
  entryPoints: ["src/llm-action-policy.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/llm-action-policy.mjs",
  sourcemap: false,
  logLevel: "info",
});
const llmContextFilesCtx = await esbuild.context({
  entryPoints: ["src/llm-context-files.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/llm-context-files.mjs",
  sourcemap: false,
  logLevel: "info",
});
const llmAnalysisInputCtx = await esbuild.context({
  entryPoints: ["src/llm-analysis-input.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: ESM_NODE_BANNER,
  target: "node20",
  outfile: "dist/llm-analysis-input.mjs",
  sourcemap: false,
  logLevel: "info",
});
const previewSupportCtx = await esbuild.context({
  entryPoints: ["src/preview-support.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "LaisoraPreview",
  target: "es2022",
  outfile: "dist/preview-support.js",
  sourcemap: false,
  logLevel: "info",
});
if (watch) {
  await Promise.all([extensionCtx.watch(), harnessCtx?.watch(), webviewCtx.watch(), workModelCtx.watch(), eventWindowCtx.watch(), historyWindowCtx.watch(), conversationHistoryCtx.watch(), progressProtocolCtx.watch(), llmReportCtx.watch(), projectionCtx.watch(), handoffEnvelopeCtx.watch(), handoffAcceptCtx.watch(), handoffRunnerCtx.watch(), sendBoundaryCtx.watch(), observedSeedCtx.watch(), humanVocabCtx.watch(), handoffCapsuleCtx.watch(), artifactAccessCtx.watch(), toolObservationCtx.watch(), protocolCtx.watch(), evidenceIndexCtx.watch(), claudeNormalizerCtx.watch(), semanticModelCtx.watch(), sessionTranscriptCtx.watch(), l3AnalysisCtx.watch(), l3DivergenceCtx.watch(), guardrailCtx.watch(), steeringEnvelopeCtx.watch(), sessionDisplayTitleCtx.watch(), llmCitationAliasCtx.watch(), llmFindingVerifyCtx.watch(), llmAnalysisClientCtx.watch(), llmAnalysisSdkClientCtx.watch(), llmAnalysisPromptCtx.watch(), llmActionPolicyCtx.watch(), llmContextFilesCtx.watch(), llmAnalysisInputCtx.watch(), previewSupportCtx.watch(), settingsPageCtx.watch()]);
} else {
  // dist/*.meta.json list the packages inside the three shipped bundles (third-party notices are enumerated from them)
  const settingsRebuild = settingsPageCtx.rebuild();
  const [extensionResult, , webviewResult] = await Promise.all([extensionCtx.rebuild(), harnessCtx?.rebuild(), webviewCtx.rebuild(), workModelCtx.rebuild(), eventWindowCtx.rebuild(), historyWindowCtx.rebuild(), conversationHistoryCtx.rebuild(), progressProtocolCtx.rebuild(), llmReportCtx.rebuild(), projectionCtx.rebuild(), handoffEnvelopeCtx.rebuild(), handoffAcceptCtx.rebuild(), handoffRunnerCtx.rebuild(), sendBoundaryCtx.rebuild(), observedSeedCtx.rebuild(), humanVocabCtx.rebuild(), handoffCapsuleCtx.rebuild(), artifactAccessCtx.rebuild(), toolObservationCtx.rebuild(), protocolCtx.rebuild(), evidenceIndexCtx.rebuild(), claudeNormalizerCtx.rebuild(), semanticModelCtx.rebuild(), sessionTranscriptCtx.rebuild(), l3AnalysisCtx.rebuild(), l3DivergenceCtx.rebuild(), guardrailCtx.rebuild(), steeringEnvelopeCtx.rebuild(), sessionDisplayTitleCtx.rebuild(), llmCitationAliasCtx.rebuild(), llmFindingVerifyCtx.rebuild(), llmAnalysisClientCtx.rebuild(), llmAnalysisSdkClientCtx.rebuild(), llmAnalysisPromptCtx.rebuild(), llmActionPolicyCtx.rebuild(), llmContextFilesCtx.rebuild(), llmAnalysisInputCtx.rebuild(), previewSupportCtx.rebuild(), settingsRebuild]);
  writeFileSync("dist/extension.meta.json", JSON.stringify(extensionResult.metafile));
  writeFileSync("dist/webview.meta.json", JSON.stringify(webviewResult.metafile));
  writeFileSync("dist/settings.meta.json", JSON.stringify((await settingsRebuild).metafile));
  await Promise.all([extensionCtx.dispose(), harnessCtx?.dispose(), webviewCtx.dispose(), workModelCtx.dispose(), eventWindowCtx.dispose(), historyWindowCtx.dispose(), conversationHistoryCtx.dispose(), progressProtocolCtx.dispose(), llmReportCtx.dispose(), projectionCtx.dispose(), handoffEnvelopeCtx.dispose(), handoffAcceptCtx.dispose(), handoffRunnerCtx.dispose(), sendBoundaryCtx.dispose(), observedSeedCtx.dispose(), humanVocabCtx.dispose(), handoffCapsuleCtx.dispose(), artifactAccessCtx.dispose(), toolObservationCtx.dispose(), protocolCtx.dispose(), evidenceIndexCtx.dispose(), claudeNormalizerCtx.dispose(), semanticModelCtx.dispose(), sessionTranscriptCtx.dispose(), l3AnalysisCtx.dispose(), l3DivergenceCtx.dispose(), guardrailCtx.dispose(), steeringEnvelopeCtx.dispose(), sessionDisplayTitleCtx.dispose(), llmCitationAliasCtx.dispose(), llmFindingVerifyCtx.dispose(), llmAnalysisClientCtx.dispose(), llmAnalysisSdkClientCtx.dispose(), llmAnalysisPromptCtx.dispose(), llmActionPolicyCtx.dispose(), llmContextFilesCtx.dispose(), llmAnalysisInputCtx.dispose(), previewSupportCtx.dispose(), settingsPageCtx.dispose()]);
}

  // The SDK embeds model IDs such as `claude-…@2025…`. Encode the at-sign in
  // string literals so the distributed bundle contains no email-like tokens;
  // JavaScript decodes \x40 at runtime, preserving the original SDK values.
  const extensionBundlePath = "dist/extension.js";
  const extensionBundle = readFileSync(extensionBundlePath, "utf8");
  const sanitizedBundle = extensionBundle.replace(
    /([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+)/g,
    "$1\\x40$2"
  );
  writeFileSync(extensionBundlePath, sanitizedBundle);
