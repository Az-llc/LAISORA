import * as l10n from "@vscode/l10n";
import { getLaisoraConfiguration } from "./claude-settings";

import { sdkClaudeCodeVersion } from "./claudeHost";
import { configuredClaudeExecutablePath, resolveSessionCwd } from "./claude-settings";
import { extensionContext, output } from "./host-context";
import { normalizeApiKeyPolicy, type NormalizedEventBody } from "./protocol";
import { buildSessionDigest, buildSummaryPrompt, buildSessionNamePrompt, sanitizeSessionName, generateSessionSummaryViaSdk } from "./session-summary";
import { isInSessionStore, inspectorSessionFile } from "./session-files";
import { readSessionHistory } from "./session-transcript";
import type { Session } from "./extension";
import type { SessionStore } from "./store-surfaces";

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
  private nameRun: AbortController | null = null;

  constructor(
    private readonly host: Session,
    private readonly store: SessionStore
  ) {}

  private summaryPersistKey(): string | undefined {
    if (this.host.resumeSessionId !== undefined) return this.host.resumeSessionId;
    return this.host.ownerState.kind === "pinned" ? this.host.ownerState.ownerId : undefined;
  }

  private supersededSince(logicalGenerationAtStart: number): boolean {
    return this.host.logicalGeneration !== logicalGenerationAtStart;
  }

  resetForLogicalSession(): void {
    this.nameRun?.abort();
    this.nameRun = null;
    this.host.summaryRun?.abort();
    this.host.summaryRun = null;
    this.host.sessionSummary = null;
    this.summaryHydrated = false;
  }

  hydratedSessionSummary(): { text: string; model: string } | null {
    if (!this.summaryHydrated) {
      this.summaryHydrated = true;
      if (this.host.sessionSummary === null) {
        const key = this.summaryPersistKey();
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
    await this.requestSummary("summary");
  }

  async requestSessionNameSuggestion(): Promise<void> {
    await this.requestSummary("name");
  }

  private async requestSummary(purpose: "summary" | "name"): Promise<void> {
    const naming = purpose === "name";
    if (naming ? this.nameRun !== null : this.host.summaryRun !== null) return;
    const logicalGenerationAtStart = this.host.logicalGeneration;
    const abort = new AbortController();
    if (naming) this.nameRun = abort;
    else {
      this.host.summaryRun = abort;
      this.postSessionSummaryState(true);
    }
    let suggestion: string | undefined;
    let saveFailed = false;
    let failure: string | undefined;
    try {
      const modelId = "haiku";

      const { userTexts, toolCalls, agentCount, readFailure } = await this.collectSummaryInput();
      if (this.supersededSince(logicalGenerationAtStart)) return;
      if (userTexts.length === 0) {
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
      output.appendLine(`[${this.host.title}] 要約を開始します（トークンを消費します・モデル: ${modelId}）`);
      const result = await generateSessionSummaryViaSdk({
        modelId,
        apiKeyPolicy: normalizeApiKeyPolicy(getLaisoraConfiguration().get("claude.apiKeyPolicy", "inherit")),
        cwd: resolveSessionCwd(this.host) ?? process.cwd(),
        prompt: (naming ? buildSessionNamePrompt : buildSummaryPrompt)(buildSessionDigest(userTexts, toolCalls, agentCount)),
        signal: abort.signal,
        pathToClaudeCodeExecutable: configuredClaudeExecutablePath(getLaisoraConfiguration()),
        sdkClaudeCodeVersion: sdkClaudeCodeVersion(),
      });
      if (this.supersededSince(logicalGenerationAtStart)) return;
      if (result.summary !== undefined) {
        if (naming) {
          suggestion = sanitizeSessionName(result.summary) || undefined;
          if (suggestion === undefined) failure = l10n.t("Could not generate a session name.");
        } else {
          this.host.sessionSummary = { text: result.summary, model: result.model ?? modelId ?? "default" };
          saveFailed = !(await this.persistSessionSummary());
        }
      } else {
        output.appendLine(`[${this.host.title}] 要約を生成できませんでした（応答が空）`);
        failure = l10n.t("LAISORA: Could not generate the summary.");
      }
    } catch (error) {
      const superseded = this.supersededSince(logicalGenerationAtStart);
      output.appendLine(`[${this.host.title}] 要約${superseded ? "を中断（論理セッションの切替）" : "に失敗"}: ${String(error)}`);
      if (superseded) return;
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 120);
      failure = l10n.t("LAISORA: Summary failed — {0}", reason);
    } finally {
      if (naming && this.nameRun === abort) {
        this.nameRun = null;
        this.store.post(suggestion !== undefined
          ? { type: "sessionNameSuggestion", tabId: this.host.tabId, title: suggestion }
          : { type: "sessionNameSuggestion", tabId: this.host.tabId, reason: failure ?? l10n.t("Could not generate a session name.") });
      } else if (!naming && this.host.summaryRun === abort) {
        this.host.summaryRun = null;
        this.postSessionSummaryState(false, saveFailed, failure);
      }
    }
  }

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
