import * as vscode from "vscode";

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { claudeConfigDir } from "./claude-env";
import { extensionContext, output } from "./host-context";
import { PERMISSION_MODES, PermissionModeId } from "./protocol";
import type { ModelInfo } from "./protocol";
import type { Session } from "./extension";
import type * as ClaudeCodeSdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

import { readClaudeCodeSettings, invalidateClaudeCodeSettingsCache, notifyAutoContinueSettingChange } from "./claude-code-settings";
export { readClaudeCodeSettings, invalidateClaudeCodeSettingsCache, onAutoContinueSettingChange } from "./claude-code-settings";

// Claude Code のユーザー設定へキーを書き戻す（独自設定を作らない方針の帰結: モデル/effort の
// 選択は本体と同じ ~/.claude/settings.json に保存し、再起動後も他セッションとも同期させる）。
// 実測（2026-08-07）: 本体の /model でモデルを選ぶと settings.json の model が書き換わり、
// 再起動後もその値で起動する。LAISORA だけ保存しないと挙動が食い違う。
// 値に null/undefined を渡すとそのキーを削除する（＝既定へ戻す）。
// オブジェクトは指定された末端キーだけを更新し、他モデルの設定や未知のキーを保持する。
// 破壊防止: 既存ファイルのパースに失敗したら**書かない**（コメント付きJSON等を消さない）。
// 書き込みは一時ファイル経由の置換にして、途中で落ちても設定を半端な状態にしない。
type SettingsPatch = { [key: string]: string | boolean | null | undefined | SettingsPatch };

function mergeSettingsPatch(current: Record<string, unknown>, patch: SettingsPatch): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete current[key];
    else if (typeof value === "object") {
      const previous = current[key];
      const nested = previous && typeof previous === "object" && !Array.isArray(previous)
        ? { ...previous as Record<string, unknown> } : {};
      mergeSettingsPatch(nested, value);
      Object.defineProperty(current, key, { value: nested, enumerable: true, configurable: true, writable: true });
    } else Object.defineProperty(current, key, { value, enumerable: true, configurable: true, writable: true });
  }
}

// 保存の成否は呼び出し元へ返し、通知は呼び出し元（操作したタブの会話）が出す。ここで toast を出すと
// 操作元のタブと無関係な場所に「保存失敗」が出て、会話側の「切り替えました」と矛盾する（R-DSP-01）
export type SettingsWriteResult =
  | { ok: true }
  | { ok: false; reason: "read_failed" | "write_failed"; detail: string };

export function updateClaudeCodeSettings(patch: SettingsPatch): SettingsWriteResult {
  const file = join(claudeConfigDir(), "settings.json");
  let current: Record<string, unknown> = {};
  try {
    const raw = readFileSync(file, "utf8");
    current = JSON.parse(raw) as Record<string, unknown>;
    if (typeof current !== "object" || current === null) throw new Error("not an object");
  } catch (e) {
    // 「ファイルが無い」以外の読み取り失敗（EACCES/EBUSY/EMFILE 等）を空ファイル扱いにすると、
    // hooks・permissions・env などを載せた既存の設定を patch だけの内容で丸ごと消してしまう。
    // 読めなかったのか、そもそも無いのかを必ず区別する（敵対レビュー R2-HIGH）。
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      output.appendLine(`[settings] 読み取り/解析に失敗したため書き込みを中止: ${String(e)}`);
      return { ok: false, reason: "read_failed", detail: String(e) };
    }
    current = {};
  }
  mergeSettingsPatch(current, patch);
  if (patch.modelSettings && typeof patch.modelSettings === "object") {
    const rows = current.modelSettings as Record<string, unknown>;
    for (const model of Object.keys(patch.modelSettings)) {
      const row = rows[model];
      if (row && typeof row === "object" && Object.keys(row).length === 0) delete rows[model];
    }
    if (Object.keys(rows).length === 0) delete current.modelSettings;
  }
  // tmp 名にプロセスIDを入れる。固定名だと複数の VS Code ウィンドウが同時保存したときに
  // 同じ tmp を奪い合い、片方の書きかけが renameSync で確定して JSON が壊れる。
  const tmp = `${file}.laisora.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    output.appendLine(`[settings] 保存: ${JSON.stringify(patch)}`);
    invalidateClaudeCodeSettingsCache();
    if ("autoContinueAtUsageLimit" in patch) notifyAutoContinueSettingChange();
    return { ok: true };
  } catch (e) {
    // 解析失敗時だけ返して書き込み失敗を黙って落とすと、UI は「切り替わった」表示のまま
    // ファイルは旧値という無言の食い違いになる。両方とも理由付きで返す。
    output.appendLine(`[settings] 保存に失敗: ${String(e)}`);
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 後始末の失敗は無視してよい（本体の失敗通知が優先） */
    }
    return { ok: false, reason: "write_failed", detail: String(e) };
  }
}

// SDK Settings.modelSettings is keyed by canonical model name; resolvedModel may carry a
// trailing [1m] (e.g. default / opus[1m] -> claude-opus-5[1m]) whose settings key is claude-opus-5.
function modelSettingsKey(resolvedModel: string): string {
  return resolvedModel.endsWith("[1m]") ? resolvedModel.slice(0, -"[1m]".length) : resolvedModel;
}

const BUILTIN_CANONICAL_MODEL = /^claude-(?:opus|sonnet|haiku|fable)-\d+(?:-\d{1,2})?$/;

function settingsKeysForModel(selected: string, models: readonly Pick<ModelInfo, "id" | "resolvedModel">[]): Set<string> {
  const keys = new Set(models.filter((row) => row.id === selected || row.resolvedModel === selected)
    .map((row) => row.resolvedModel).filter((key): key is string => typeof key === "string" && key.length > 0)
    .map(modelSettingsKey));
  // A CLI started with a resolved id (handoff inherits claude-opus-5-5[1m]) lists no row for that id
  // (CLI 2.1.280). A built-in id is already the settings key once [1m] is dropped.
  if (keys.size === 0 && BUILTIN_CANONICAL_MODEL.test(modelSettingsKey(selected))) keys.add(modelSettingsKey(selected));
  return keys;
}

export function canonicalEffortModel(s: Session): string | undefined {
  // 初回送信前は CLI の init が来ておらず effectiveModel が無い。CLI が get_settings で報告した applied model を先に使い
  // （resume の CLI は設定ではなく記録の model で走る）、無ければ設定の model、それも無ければ SDK 一覧の "default" 行で解く。
  // 設定を解けていない間は推測しない
  const snapshot = s.configuredEffortSnapshot;
  const selected = s.modelOverride ?? s.effectiveModel ?? s.appliedModel ?? (snapshot ? snapshot.resolvedModel ?? "default" : undefined);
  if (!selected) return undefined;
  const keys = settingsKeysForModel(selected, s.models);
  const key = keys.size === 1 ? [...keys][0] : undefined;
  // The CLI matches a canonical key against dated / Bedrock / Vertex spellings too, but nothing here derives
  // the canonical key from those IDs (or from custom IDs). Persist only unqualified built-in IDs.
  return key && BUILTIN_CANONICAL_MODEL.test(key) ? key : undefined;
}

// null = 保存を試みなかった（max は session-only で settings.json へ書かない。R-CMD-02）
export function saveClaudeModelEffort(model: string, effort: Session["effortOverride"] | null): SettingsWriteResult | null {
  if (effort === "max") return null;
  return updateClaudeCodeSettings({ modelSettings: { [model]: { effortLevel: effort } } });
}

export type ConfiguredEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ConfiguredEffortSnapshot {
  environmentSpecified: boolean;
  environmentEffort?: ConfiguredEffort;
  globalEffort?: ConfiguredEffort;
  hasModelSettings: boolean;
  modelEfforts: Record<string, ConfiguredEffort>;
  resolvedModel?: string;
}

const CONFIGURED_EFFORT_RESOLVE_TIMEOUT_MS = 3_000;

function configuredEffort(value: unknown): ConfiguredEffort | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

export function configuredEffortFromSnapshot(
  snapshot: ConfiguredEffortSnapshot,
  model: string | null | undefined,
  models: readonly Pick<ModelInfo, "id" | "resolvedModel">[]
): ConfiguredEffort | undefined {
  // settings.env は CLI が子へ与える環境。キーがあれば無効値も「環境で上書きされた」と扱い、
  // 下位の model/global 設定を表示しない。親 process.env は buildClaudeEnv が除去するため見ない。
  if (snapshot.environmentSpecified) return snapshot.environmentEffort;

  const canonicalModels = canonicalSettingsKeys(snapshot, model, models);
  if (snapshot.hasModelSettings && canonicalModels.size !== 1) return undefined;
  if (canonicalModels.size === 1) {
    const rowEffort = snapshot.modelEfforts[[...canonicalModels][0]];
    if (rowEffort !== undefined) return rowEffort;
  }
  return snapshot.globalEffort;
}

function canonicalSettingsKeys(
  snapshot: ConfiguredEffortSnapshot,
  model: string | null | undefined,
  models: readonly Pick<ModelInfo, "id" | "resolvedModel">[]
): Set<string> {
  const selectedModel = model ?? snapshot.resolvedModel;
  return selectedModel === null || selectedModel === undefined ? new Set() : settingsKeysForModel(selectedModel, models);
}

// applied.effort は env・設定・フラグ層を反映した値なので、現在のモデルに効く層（env > そのモデルの行 > global）に
// effort が無いと確かめられたときだけ既定と呼ぶ。行があるのにモデルを解けない間は既定と呼ばない
export function defaultEffortFromSnapshot(
  snapshot: ConfiguredEffortSnapshot | undefined,
  model: string | null | undefined,
  models: readonly Pick<ModelInfo, "id" | "resolvedModel">[],
  applied: ConfiguredEffort | null | undefined
): ConfiguredEffort | undefined {
  if (snapshot === undefined || applied === null || applied === undefined) return undefined;
  if (snapshot.environmentSpecified || snapshot.globalEffort !== undefined) return undefined;
  if (Object.keys(snapshot.modelEfforts).length === 0) return applied;
  const keys = canonicalSettingsKeys(snapshot, model, models);
  return keys.size === 1 && snapshot.modelEfforts[[...keys][0]] === undefined ? applied : undefined;
}

// The settings layers only predict the effort; the CLI can ignore them (CLI 2.1.280 drops the top-level
// effortLevel for claude-opus-5-5). Once applied.effort is known, a layer is named only
// when it agrees with it; otherwise the webview shows the applied value unlabelled (R-CMD-02).
export function effortDisplayFromSnapshot(
  snapshot: ConfiguredEffortSnapshot | undefined,
  model: string | null | undefined,
  models: readonly Pick<ModelInfo, "id" | "resolvedModel">[],
  applied: ConfiguredEffort | null | undefined
): { configured?: ConfiguredEffort; default?: ConfiguredEffort } {
  const configured = snapshot === undefined ? undefined : configuredEffortFromSnapshot(snapshot, model, models);
  if (applied === undefined || (configured !== undefined && configured === applied)) {
    return configured === undefined ? {} : { configured };
  }
  const fallback = defaultEffortFromSnapshot(snapshot, model, models, applied);
  return fallback === undefined ? {} : { default: fallback };
}

export async function resolveConfiguredEffortSnapshot(
  cwd: string,
  settingSources: Array<"user" | "project" | "local">
): Promise<ConfiguredEffortSnapshot | undefined> {
  const sdk = require("@anthropic-ai/claude-agent-sdk") as Pick<typeof ClaudeCodeSdk, "resolveSettings">;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const resolved = await Promise.race([
      sdk.resolveSettings({ cwd, settingSources }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`resolveSettings timeout (${CONFIGURED_EFFORT_RESOLVE_TIMEOUT_MS}ms)`)),
          CONFIGURED_EFFORT_RESOLVE_TIMEOUT_MS
        );
      }),
    ]);
    const effective = resolved.effective as Record<string, unknown>;
    const env = effective.env;
    const environmentSpecified =
      typeof env === "object" &&
      env !== null &&
      Object.prototype.hasOwnProperty.call(env, "CLAUDE_CODE_EFFORT_LEVEL");
    const environmentEffort = environmentSpecified
      ? configuredEffort((env as Record<string, unknown>).CLAUDE_CODE_EFFORT_LEVEL)
      : undefined;
    const rawModelSettings = effective.modelSettings;
    const hasModelSettings =
      typeof rawModelSettings === "object" &&
      rawModelSettings !== null &&
      !Array.isArray(rawModelSettings) &&
      Object.keys(rawModelSettings).length > 0;
    const modelEfforts: Record<string, ConfiguredEffort> = {};
    if (hasModelSettings) {
      for (const [model, rawRow] of Object.entries(rawModelSettings as Record<string, unknown>)) {
        if (typeof rawRow !== "object" || rawRow === null || Array.isArray(rawRow)) continue;
        const effort = configuredEffort((rawRow as Record<string, unknown>).effortLevel);
        if (effort !== undefined) modelEfforts[model] = effort;
      }
    }
    const globalEffort = configuredEffort(effective.effortLevel);
    const modelSetting = process.env.ANTHROPIC_MODEL || effective.model;
    const resolvedModel = typeof modelSetting === "string" && modelSetting.length > 0
      ? modelSetting
      : undefined;
    return {
      environmentSpecified,
      ...(environmentEffort === undefined ? {} : { environmentEffort }),
      ...(globalEffort === undefined ? {} : { globalEffort }),
      hasModelSettings,
      modelEfforts,
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
    };
  } catch (error) {
    output.appendLine(`[settings] configured effort resolution failed: ${String(error)}`);
    return undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

// 初期権限モード: Claude Code の permissions.defaultMode と同期（独自設定を作らない方針）。
// SDK は auto / dontAsk も受けるためパススルーする（auto を acceptEdits へ降格すると、Auto なのに承認が来る）
// 権限モードの保存先は LAISORA 内部（globalState）。本体の ~/.claude/settings.json は
// 読むだけにする。公式拡張（Anthropic.claude-code 2.1.259）の実測でも、model / effort は
// 共有ファイルへ書かれる一方、UI での権限モード変更は共有ファイルにも VS Code 設定にも
// 書かれない（2026-09-04 実測）。安全側の姿勢は面ごとに違ってよく、LAISORA で変えた
// モードが CLI や他セッションの既定まで変えるのは利用者の予期しない副作用になる。
// 独自の「既定値」は持たない（保存値が無ければ本体設定に従う。R-OPS-02）
export const PERMISSION_MODE_KEY = "laisora.permissionMode.v1";

export function resolveInitialMode(): PermissionModeId {
  const saved = extensionContext?.globalState?.get(PERMISSION_MODE_KEY);
  if (typeof saved === "string" && (PERMISSION_MODES as string[]).includes(saved)) {
    return saved as PermissionModeId;
  }
  const m = readClaudeCodeSettings().defaultMode;
  if (m && (PERMISSION_MODES as string[]).includes(m)) return m as PermissionModeId;
  return "default";
}

// 未起動時のユーザー設定は実効値ではない。継承を明示的な起動指定へ昇格させるのは、
// このセッションの選択値または起動後に観測できた値だけに限る。
export function inheritedProfile(s: Session): { model: string | null | undefined; effort: Session["effortOverride"] } {
  if (s.effectiveModel !== undefined) return { model: s.effectiveModel, effort: s.effortOverride ?? s.effectiveEffort };
  return {
    model: s.modelOverride,
    effort: s.effortOverride,
  };
}

// resolveClaudeCodeStartup は configuredPath と sdkVersion を連結した単一スロットで
// キャッシュする。チャットと分析で渡す値が食い違うと解決結果が「割れる」のではなく
// 互いを追い出し、次の会話生成が --version を再 spawn する。値の出どころを1つに保つ
export function configuredClaudeExecutablePath(cfg: vscode.WorkspaceConfiguration): string | undefined {
  return cfg.get<string>("claude.executablePath", "").trim() || undefined;
}

// VS Code は Windows のドライブレターを小文字へ正規化して返すが、git は大文字を返す。
// Claude Code の worktree 隔離ガードは両者を大小区別で比較するため、小文字のまま SDK へ渡すと
// isolation が常に拒否される。SDK へ渡す cwd の唯一の集約点がここなので、綴りはここで揃える。
export function normalizeDriveLetter(cwd: string): string {
  return /^[a-z]:/.test(cwd) ? cwd[0].toUpperCase() + cwd.slice(1) : cwd;
}

// 履歴から開いたタブ（resumeFilePath あり）は、openResumedSession が記録の所在ディレクトリと突合して
// 固定した作業ディレクトリで起動する。設定と現在の workspace を先に見ると、別プロジェクトのセッションを
// 再開したときに別リポジトリでツールが動く（AUDIT-02）。固定した cwd が実在しなくても差し替えないこと:
// 差し替えは「黙って別のディレクトリで起動する」ものであり、この欠陥そのものになる。
// defaultCwd の読みを分岐の中へ入れない（設定未供給を throw で表す検査ハーネスで、
// 再開タブだけが CLI 起動へ進む）
export function resolveSessionCwd(s: Session): string | undefined {
  const cfg = getLaisoraConfiguration();
  const configured = cfg.get<string>("defaultCwd") || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pinnedByResume = s.resumeFilePath !== undefined && s.cwd.length > 0 ? s.cwd : undefined;
  // R-CNV-34: with no folder open, fall back to the home directory like the official Claude Code extension.
  const cwd = pinnedByResume || configured || s.cwd || homedir() || undefined;
  return cwd === undefined ? undefined : normalizeDriveLetter(cwd);
}

export function getLaisoraConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("laisora");
}
