import * as l10n from "@vscode/l10n";
import { getLaisoraConfiguration } from "./claude-settings";

import { sdkClaudeCodeVersion } from "./claudeHost";
import { configuredClaudeExecutablePath, readClaudeCodeSettings, resolveSessionCwd } from "./claude-settings";
import { extensionContext, output } from "./host-context";
import { normalizeApiKeyPolicy, type NormalizedEventBody } from "./protocol";
import { buildSessionDigest, buildSummaryPrompt, generateSessionSummaryViaSdk } from "./session-summary";
import { isInSessionStore, inspectorSessionFile } from "./session-files";
import { readSessionHistory } from "./session-transcript";
import type { Session } from "./extension";
import type { SessionStore } from "./store-surfaces";

// セッション概要の要約の保存先（R-DSP-25）。sessionId → { text, model, generatedAt }
export const SESSION_SUMMARY_STORE_KEY = "laisora.sessionSummary.v1";
const SESSION_SUMMARY_STORE_MAX = 500;

interface SummaryInputFailure {
  kind: "file_not_located" | "read_error" | "read_threw";
  detail: string;
}

const SUMMARY_INPUT_FAILURE_LABELS: Record<SummaryInputFailure["kind"], string> = {
  file_not_located: "記録ファイルの場所を特定できませんでした",
  read_error: "記録ファイルを読めませんでした",
  read_threw: "記録ファイルの読み直しに失敗しました",
};

function localizedSummaryInputFailure(kind: SummaryInputFailure["kind"]): string {
  switch (kind) {
    case "file_not_located":
      return l10n.t("The record file could not be located.");
    case "read_error":
      return l10n.t("The record file could not be read.");
    case "read_threw":
      return l10n.t("The record file could not be read again.");
  }
}

function summaryInputFromEvents(
  events: readonly NormalizedEventBody[]
): { userTexts: string[]; toolCalls: number; agentCount: number } {
  const userTexts: string[] = [];
  let toolCalls = 0;
  let agentCount = 0;
  for (const ev of events) {
    if (ev.kind === "user_message" && ev.text.trim().length > 0) userTexts.push(ev.text);
    else if (ev.kind === "replayed_message" && ev.role === "user" && ev.text.trim().length > 0) userTexts.push(ev.text);
    else if (ev.kind === "tool_call_started") {
      toolCalls += 1;
      if (ev.delegation !== undefined) agentCount += 1;
    }
  }
  return { userTexts, toolCalls, agentCount };
}

export class SessionSummaryWiring {
  private summaryHydrated = false;

  constructor(
    private readonly host: Session,
    private readonly store: SessionStore
  ) {}

  private summaryPersistKey(): string | undefined {
    if (this.host.resumeSessionId !== undefined) return this.host.resumeSessionId;
    return this.host.ownerState.kind === "pinned" ? this.host.ownerState.ownerId : undefined;
  }

  // 保存先は完了時点の Session から summaryPersistKey() で引き直すので、生成中に /clear や
  // resume が入った結果をそのまま書き戻すと、旧会話の要約が新会話の ID で永続保存される（W-SUM-6）
  private supersededSince(logicalGenerationAtStart: number): boolean {
    return this.host.logicalGeneration !== logicalGenerationAtStart;
  }

  // resetLogicalSession 専用。写しと hydration 済みフラグを落とさないと、旧会話の要約が
  // 新しい世代の snapshot に載り続ける（保存先の鍵は世代とともに変わる）
  resetForLogicalSession(): void {
    this.host.summaryRun?.abort();
    this.host.summaryRun = null;
    this.host.sessionSummary = null;
    this.summaryHydrated = false;
  }

  // 保存済みの要約は resume を跨いで sessionId で引く（R-DSP-25「結果は保存する」）
  hydratedSessionSummary(): { text: string; model: string } | null {
    if (!this.summaryHydrated) {
      this.summaryHydrated = true;
      if (this.host.sessionSummary === null) {
        const key = this.summaryPersistKey();
        // 検収ハーネスの stub context は globalState を持たない。無ければ保存なし（写しも空）として動く
        const gs = extensionContext?.globalState;
        if (key !== undefined && gs !== undefined) {
          const store = gs.get<Record<string, { text?: unknown; model?: unknown }>>(SESSION_SUMMARY_STORE_KEY);
          const rec = store?.[key];
          if (rec !== undefined && typeof rec.text === "string" && typeof rec.model === "string") {
            this.host.sessionSummary = { text: rec.text, model: rec.model };
          }
        }
      }
    }
    return this.host.sessionSummary;
  }

  // failure は実行しなかった / 生成できなかった理由。既存の要約（summary）と同じ便で運ぶので、
  // 失敗の通知が保存済みの要約を消さない（R-DSP-25 / R-DSP-01）
  private postSessionSummaryState(running: boolean, saveFailed = false, failure?: string): void {
    const summary = this.host.sessionSummary;
    this.store.post({
      type: "sessionSummary",
      tabId: this.host.tabId,
      running,
      ...(summary !== null ? { summary } : {}),
      ...(saveFailed ? { saveFailed: true } : {}),
      ...(failure !== undefined ? { failure } : {}),
    });
  }

  async requestSessionSummary(): Promise<void> {
    if (this.host.summaryRun !== null) return;
    const logicalGenerationAtStart = this.host.logicalGeneration;
    const abort = new AbortController();
    this.host.summaryRun = abort;
    this.postSessionSummaryState(true);
    let saveFailed = false;
    let failure: string | undefined;
    try {
      // R-DSP-25
      let modelId: string | undefined = this.host.modelOverride ?? this.host.effectiveModel ?? undefined;
      if (!modelId) {
        modelId = readClaudeCodeSettings().model ?? undefined;
      }
      const effort = this.host.effortOverride ?? this.host.effectiveEffort;

      const { userTexts, toolCalls, agentCount, readFailure } = await this.collectSummaryInput();
      if (this.supersededSince(logicalGenerationAtStart)) return;
      if (userTexts.length === 0) {
        // 「記録が無い」と「記録を確かめられなかった」を分ける。読み直しに失敗しただけのときに
        // 前者を名乗ると、発言が多数あるセッションについて存在の否定を断言する（R-30）
        const reason =
          readFailure === undefined
            ? "要約する記録がまだありません"
            : `${SUMMARY_INPUT_FAILURE_LABELS[readFailure.kind]}（記録が無いという意味ではありません。同期や権限の状態を確認してください）`;
        output.appendLine(
          `[${this.host.title}] 要約を実行しませんでした: ${reason}${readFailure === undefined ? "" : ` / ${readFailure.detail}`}`
        );
        failure =
          readFailure === undefined
            ? l10n.t("LAISORA: There is no record to summarize yet.")
            : l10n.t(
                "LAISORA: {0} (This does not mean there is no record. Check sync and permissions.)",
                localizedSummaryInputFailure(readFailure.kind)
              );
        return;
      }
      output.appendLine(`[${this.host.title}] 要約を開始します（トークンを消費します${modelId ? `・モデル: ${modelId}` : ""}）`);
      const result = await generateSessionSummaryViaSdk({
        ...(modelId !== undefined ? { modelId } : {}),
        apiKeyPolicy: normalizeApiKeyPolicy(getLaisoraConfiguration().get("claude.apiKeyPolicy", "inherit")), // R-GW-05
        ...(effort !== undefined ? { effort } : {}),
        cwd: resolveSessionCwd(this.host) ?? process.cwd(),
        prompt: buildSummaryPrompt(buildSessionDigest(userTexts, toolCalls, agentCount)),
        signal: abort.signal,
        pathToClaudeCodeExecutable: configuredClaudeExecutablePath(getLaisoraConfiguration()),
        sdkClaudeCodeVersion: sdkClaudeCodeVersion(),
      });
      if (this.supersededSince(logicalGenerationAtStart)) return;
      if (result.summary !== undefined) {
        this.host.sessionSummary = { text: result.summary, model: result.model ?? modelId ?? "default" };
        saveFailed = !(await this.persistSessionSummary());
      } else {
        output.appendLine(`[${this.host.title}] 要約を生成できませんでした（応答が空）`);
        failure = l10n.t("LAISORA: Could not generate the summary.");
      }
    } catch (error) {
      const superseded = this.supersededSince(logicalGenerationAtStart);
      output.appendLine(`[${this.host.title}] 要約${superseded ? "を中断（論理セッションの切替）" : "に失敗"}: ${String(error)}`);
      // /clear などによる中断は利用者の操作の結果なので、失敗として通知しない
      if (superseded) return;
      // 実際に何が起きたかを理由付きで出す（R-DSP-01）。全文は Output にある
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 120);
      failure = l10n.t("LAISORA: Summary failed — {0}", reason);
    } finally {
      // 同一性で見る。世代交代後に始まった新しい実行の running 表示を、中断された旧実行が消さない。
      // 失敗理由も同じ便に載せるので、旧実行の失敗が新しい実行の状態を巻き戻さない
      if (this.host.summaryRun === abort) {
        this.host.summaryRun = null;
        // 保存に失敗した要約を「保存済み」と表示させない（R-DSP-01 / R-DSP-25）
        this.postSessionSummaryState(false, saveFailed, failure);
      }
    }
  }

  // 要約の入力。fold 側の this.host.events は上限到達で先頭から切り詰められる（droppedEventCount）ため、
  // 切り詰めが起きているセッションでは JSONL（全期間の集計と同じ出所 — R-TAB-07 の whole-session 経路）
  // から読み直す。JSONL が読めなければ切り詰め済みイベント列で代用し、readFailure に理由を載せる。
  // 分類は「どこで失敗したか」だけで決める。例外文の部分一致で原因を名乗ると、OS の別の失敗まで
  // 同じ対処へ誘導する（R-28 と同型）。readFailure を「読めたが空だった」ときに立てないこと。
  // 立てると、発言の無いセッションについて「読めませんでした」と逆向きの誤りを断言する（R-30）
  private async collectSummaryInput(): Promise<{
    userTexts: string[];
    toolCalls: number;
    agentCount: number;
    readFailure?: SummaryInputFailure;
  }> {
    if ((this.host.workModel.coverage.droppedEventCount ?? 0) > 0) {
      const file = inspectorSessionFile(this.host);
      let failure: SummaryInputFailure | undefined =
        file === null ? { kind: "file_not_located", detail: "セッションの記録ファイルを特定できません" } : undefined;
      if (file !== null) {
        try {
          const history = await readSessionHistory(file, isInSessionStore);
          const readError = history.readError ?? history.subagentsReadError;
          if (readError === undefined) {
            const fromJsonl = summaryInputFromEvents(history.events.map((h) => h.body));
            if (fromJsonl.userTexts.length > 0) return fromJsonl;
          } else {
            failure = { kind: "read_error", detail: readError };
          }
        } catch (error) {
          failure = { kind: "read_threw", detail: String(error) };
          output.appendLine(`[${this.host.title}] 要約: JSONL の読み直しに失敗: ${failure.detail}`);
        }
      }
      output.appendLine(
        `[${this.host.title}] 要約: ${failure === undefined ? "JSONL に人の発言がありません" : `JSONL を読めません: ${failure.detail}`} — 保持中のイベント列（先頭切り詰めあり）で代用します`
      );
      return { ...summaryInputFromEvents(this.host.events), ...(failure !== undefined ? { readFailure: failure } : {}) };
    }
    return summaryInputFromEvents(this.host.events);
  }

  // 保存できたら true。cap の理由: globalState は拡張全体で共有される保存域で、上限なしに貯めると
  // state の読み書き全体が肥大化する。溢れても黙って捨てず、最古の分だけ削除してログに残す（新しい方を保持）
  private async persistSessionSummary(): Promise<boolean> {
    const summary = this.host.sessionSummary;
    if (summary === null) return false;
    const key = this.summaryPersistKey();
    const gs = extensionContext?.globalState;
    if (key === undefined || gs === undefined) {
      output.appendLine(`[${this.host.title}] 要約を保存できませんでした（保存先を解決できません）`);
      return false;
    }
    const store = { ...(gs.get<Record<string, { text: string; model: string; generatedAt: number }>>(SESSION_SUMMARY_STORE_KEY) ?? {}) };
    store[key] = { ...summary, generatedAt: Date.now() };
    const keys = Object.keys(store);
    if (keys.length > SESSION_SUMMARY_STORE_MAX) {
      keys.sort((a, b) => (store[a].generatedAt ?? 0) - (store[b].generatedAt ?? 0));
      const evicted = keys.slice(0, keys.length - SESSION_SUMMARY_STORE_MAX);
      for (const old of evicted) delete store[old];
      output.appendLine(`[${this.host.title}] 要約の保存件数が上限 ${SESSION_SUMMARY_STORE_MAX} を超えたため、最古の ${evicted.length} 件を削除しました（新しい方を保持）`);
    }
    try {
      await gs.update(SESSION_SUMMARY_STORE_KEY, store);
      return true;
    } catch (error) {
      output.appendLine(`[${this.host.title}] 要約の保存に失敗: ${String(error)}`);
      return false;
    }
  }
}
