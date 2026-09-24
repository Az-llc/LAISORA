import { UsageLimitResume, SDK_AUTO_CONTINUE_SETTINGS } from "./usage-limit-resume";
import { readClaudeCodeSettings, onAutoContinueSettingChange } from "./claude-code-settings";
import { modelLabelWithVersion } from "./model-display-name";
export { modelLabelWithVersion } from "./model-display-name";
import { appendRunRecord, externalDescription, isExternalTimeout, observeAgentRun, runExternal, runFailureReason, type ExternalRow, type OrchestrationRunRecord, type AgentRunRecord } from "./orchestration-external";
// ClaudeConversation: Agent SDK を長寿命 Query（ストリーミング入力モード）で駆動する。
// 1 Conversation = 1 Query = 1 CLI プロセス。interrupt はこのモード限定。

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as l10n from "@vscode/l10n";

declare const __LAISORA_SDK_CLAUDE_CODE_VERSION__: string | undefined;

// 宣言をこの1箇所に保つための読み出し口。typeof 経由なのは、esbuild の define を
// 与えずに src をバンドルする検証ハーネスでは自由識別子のまま残り、直接参照すると
// ReferenceError になるため
export function sdkClaudeCodeVersion(): string | undefined {
  return typeof __LAISORA_SDK_CLAUDE_CODE_VERSION__ === "string"
    ? __LAISORA_SDK_CLAUDE_CODE_VERSION__
    : undefined;
}
import type {
  Options as ClaudeCodeOptions,
  PermissionResult as ClaudeCodePermissionResult,
} from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type * as ClaudeCodeSdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

import type {
  AskUserQuestionSpec,
  EventProvenance,
  ImageAttachment,
  NormalizedEventBody,
  UsageSnapshot,
} from "./protocol";
import { summarizeToolInput, type ApiKeyPolicy } from "./protocol";
import { resolveClaudeCodeStartup } from "./claudeCliResolver";
import {
  buildClaudeEnv,
  claudeConfigDir,
  envNameKey,
} from "./claude-env";
import { PROGRESS_PROTOCOL_SPEC_PP1 } from "./progress-protocol";
import { checkEnvelopeRedaction } from "./send-boundary";
import { admitReportSend, admitSteeringSend, type SteeringAdmission } from "./steering-envelope";

export type SteeringSendResult = SteeringAdmission;
import type { ProgressTrackingMode } from "./progress-protocol";
import { PROGRESS_WIRE_TOOL_NAME } from "./artifact-access";
import { z } from "zod";
import { ClaudeLiveNormalizer, parseAliases } from "./claude-normalizer";
import { conductorInstruction, orchestrationExternalTargets, orchestrationAgents, resolveOrchestrationRoster, type OrchestrationRow, type ExternalModels } from "./orchestration-roster";
import { admitTransition, textHash, selectDelivery, renderDeliverySection, learningFacts, type LearningFacts, type LearningRecord, type LearningState, type LearningTransition } from "./learning";
import { sharedLearningService, type LearningResult, type LearningService } from "./learning-service";
import { createLearningMcpServer, LearningRootGate, LEARNING_INSTRUCTION, LEARNING_TOOL_NAME } from "./learning-mcp";
import { splitAgyModel, type ExecutorId } from "./orchestration-executors";
import type { NormalizedOutMeta } from "./claude-normalizer";

// The SDK is bundled into extension.js; its runtime value is obtained with synchronous require().
type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

type SDKUserMessage = {
  type: "user";
  message: { role: "user"; content: UserContentBlock[] };
  parent_tool_use_id: string | null;
  session_id: string;
  // false = assistant turn を起こさず transcript へ追記（Handoff の封筒追記で使う）。
  // SDK 仕様には「次に query する user message へマージされる」とあるが、実測では
  // 連続2通でもマージされず別レコードになる（実測 2026-08-25）
  shouldQuery?: boolean;
  isMeta?: boolean;
};

type PermissionResult = ClaudeCodePermissionResult;

type InterruptReceipt = { still_queued?: string[]; cancelled?: string[] };

// system/init の capabilities で広告される。CLI がこれを出さない場合 cancel_queued は無視される
const CAP_INTERRUPT_CANCEL_QUEUED = "interrupt_cancel_queued_v1";

// The link grammar must stay within src/file-link-target.ts#parseFileLinkTarget. Forward slashes are required:
// a Markdown link destination treats a backslash before ASCII punctuation as an escape and drops it.
export const FILE_LINK_INSTRUCTION =
  "When you mention a local file or folder, write it as a Markdown link. The link target is the absolute path or the path relative to the working directory, with forward slashes, optionally followed by #L<line> or #L<line>C<column>. Use the path and line as the link text, for example [src/app.ts:42](src/app.ts#L42) or [app.ts](C:/work/src/app.ts). Folders end with a slash: [artifacts/](artifacts/). Files such as spreadsheets, documents and PDFs are linked the same way and open in their default app. If the path contains spaces, wrap the target in angle brackets: [notes.md](<docs/my notes.md>). Write web URLs with the https:// scheme.";

// SDK 0.3.270: an omitted systemPrompt is an empty custom prompt (not the claude_code preset), so OFF passes "" to keep that prompt.
// snapshot:false is required on every launch: the default snapshot replays the prompt recorded when the session was
// first rendered on each resume (until /compact), so a changed setting would never reach a resumed conversation.
export const PLAN_INSTRUCTION = [
  "When starting multi-step work, first write a laisora-plan block with the goal as you understand it, then the TaskCreate steps; do not restate the user's words.",
  "For requests with more than one step, use TaskCreate before starting: one task per step, subject as the step title, and activeForm set.",
  "Use TaskUpdate to mark each step in_progress when starting and completed when done. Add new steps at the end with TaskCreate.",
  "When you need the user's decision or a real-machine check, do not bury it in prose. Write a ```laisora-ask block (format below) at the point you ask.",
  "In every decision, whether in a laisora-ask block or AskUserQuestion, state: what is being decided and why now; for each option, what happens after choosing it, with its merits and drawbacks in plain words rather than technical terms; your recommendation and why; and what you will do if there is no answer.",
  "Use AskUserQuestion only when you cannot continue without the answer; otherwise use a laisora-ask block and continue with the stated default.",
  "<format>",
  "A laisora-plan fence contains only goal: followed by one nonempty line in the user's language, using the same scalar rules below: ```laisora-plan\ngoal: Make progress visible throughout the work\n```.",
  "Use a fenced code block whose language is exactly laisora-ask. Use the user's language for values. This is a strict YAML-like subset: one nonempty scalar key: value per line; no comments, multiline scalars, nesting, aliases or flow collections. Plain text and JSON double-quoted strings are supported. Keys are unique. List entries use exactly two spaces before '- ' and four spaces before subsequent keys.",
  "A decision requires kind, title, why, options and default. Every option requires label, effect, pros and cons; mark your recommended option with recommended: true and explain why in its effect. Other options omit recommended.",
  "```laisora-ask\nkind: decide\ntitle: What should we choose?\nwhy: Why this decision matters now.\noptions:\n  - label: First choice\n    effect: What happens next and why I recommend it.\n    pros: Its benefit in plain words.\n    cons: Its drawback in plain words.\n    recommended: true\n  - label: Second choice\n    effect: What happens next.\n    pros: Its benefit.\n    cons: Its drawback.\ndefault: Without an answer, I will continue with A.\n```",
  "A real-machine check requires kind, title, why, steps and default. Every step requires do (the action) and look (what to observe). Do not mix options and steps.",
  "```laisora-ask\nkind: check\ntitle: Check the result on your machine\nwhy: What I cannot verify here.\nsteps:\n  - do: Open the changed screen.\n    look: Confirm the labels fit without clipping.\n  - do: Resize the window.\n    look: Confirm every action remains reachable.\ndefault: While awaiting the result, I will continue with the independent work.\n```",
  "</format>",
].join("\n");

export function conversationSystemPrompt(fileLinkInstruction: boolean, planInstruction = true): NonNullable<ClaudeCodeOptions["systemPrompt"]> {
  return { type: "custom", prompt: [fileLinkInstruction ? FILE_LINK_INSTRUCTION : "", planInstruction ? PLAN_INSTRUCTION : ""].filter(Boolean).join("\n\n"), snapshot: false };
}

interface QueryHandle extends AsyncIterable<any> {
  // sdk.d.ts の Query.interrupt() は引数なしと宣言されているが、実体（sdk.mjs）は
  // options.cancelQueued を読んで control request の cancel_queued を立てる。宣言に
  // 合わせて引数を落とすと Stop 後に CLI 側の待機入力がそのまま実行される
  interrupt(options?: { cancelQueued?: boolean }): Promise<InterruptReceipt | undefined>;
  setPermissionMode(mode: string): Promise<void>;
  supportedCommands(): Promise<Array<{ name: string; description?: string; aliases?: string[] }>>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: { effortLevel: "low" | "medium" | "high" | "xhigh" | "max" | null }): Promise<void>;
  // sdk.d.ts 0.3.272 の Query には宣言が無いが、sdk.mjs の実体は get_settings control request を送り
  // { effective, sources, applied: { model, effort, ... } } を返す（SDK 実測）。形は検証してから読む
  getSettings?(): Promise<unknown>;
  supportedModels(): Promise<Array<{ model?: string; id?: string; value?: string; resolvedModel?: string; displayName?: string; description?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }>>;
  getContextUsage(): Promise<{
    percentage: number;
    totalTokens: number;
    maxTokens: number;
    autoCompactThreshold?: number;
    isAutoCompactEnabled: boolean;
  }>;
}

export interface ClaudeHostOptions {
  cwd: string;
  // resume履歴を既にfoldしたSessionの最終時刻。新CLIの最初のsend境界へ引き継ぐ。
  initialObservedTimestamp?: number;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  // 過去セッションの再開（SDK options.resume）
  resumeSessionId?: string;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto" | "dontAsk";
  settingSources: Array<"user" | "project" | "local">;
  // LAISORA が起動するセッションで Remote Control ブリッジを立てるか。
  // 既定 false: LAISORA は会話ごとに短命な CLI を起動するため、既定 ON のままだと
  // クラウド側に切断済みセッションが溜まり、Claude Code 拡張がそれを掴んで壊れる（実測 2026-09-01）
  remoteControlAtStartup?: boolean;
  claudeCodeExecutablePath?: string;
  apiKeyPolicy?: ApiKeyPolicy;
  fileLinkInstruction?: boolean;
  planInstruction?: boolean;
  orchestrationEnabled?: boolean;
  orchestrationAgents?: unknown;
  externalModels?: ExternalModels;
  externalTimeoutMinutes?: number;
  orchestrationRunsDirectory?: string;
  learningEnabled?: boolean;
  learningDirectory?: string;
  learningScope?: string;
  configuredResolvedModel?: string;
  conductorPolicy?: string;
  onOrchestrationChanged?: () => void;
  interruptForceKillTimeoutMs: number;
  // テスト専用: provider interrupt を意図的にスキップし abort フォールバック経路を検証する。
  // 拡張本体（extension.ts）からは決して設定しないこと（敵対レビュー指摘[8]: 環境変数方式は本番汚染リスク）。
  testInterruptHang?: boolean;
  // 注入（記録させる側）のみを制御する。既に L1 に存在する
  // protocol event の抽出は設定非依存（tool-observation 側で常に行う）
  progressTracking?: ProgressTrackingMode;
  onEvent: (
    ev: NormalizedEventBody & { provenance?: EventProvenance },
    conversationId: string,
    meta?: NormalizedOutMeta
  ) => void;
  onApprovalRequest: (req: {
    requestId: string;
    toolName: string;
    rawInputJson: string;
  }) => Promise<ApprovalDecision>;
  log: (msg: string) => void;
}

// AskUserQuestion の allow 時は answers（質問文→回答）を伴う（機能B）。他ツールは answers 無し
export interface ApprovalDecision {
  behavior: "allow" | "deny";
  answers?: Record<string, string>;
}

interface PendingApproval {
  requestId: string;
  toolName: string;
  resolve: (r: ApprovalDecision) => void;
}

// AskUserQuestion の生 input（SDK AskUserQuestionInput 相当）を安全にパースする（機能B）。
// 形が想定外なら undefined を返し、呼び出し側は rawInputJson の生表示にフォールバックする。
function parseAskUserQuestionInput(input: Record<string, unknown>): AskUserQuestionSpec | undefined {
  try {
    const raw = input.questions;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    // L-4: SDK仕様は1-4問・各2-4択（sdk-tools.d.ts）。超過分は無視して先頭のみ使う（表示崩れ防止）
    const questions = raw.slice(0, 4).map((q) => {
      if (typeof q !== "object" || q === null) throw new Error("invalid question");
      const item = q as Record<string, unknown>;
      if (typeof item.question !== "string" || !Array.isArray(item.options)) {
        throw new Error("invalid question shape");
      }
      const options = item.options.slice(0, 4).map((o) => {
        if (typeof o !== "object" || o === null) throw new Error("invalid option");
        const opt = o as Record<string, unknown>;
        if (typeof opt.label !== "string") throw new Error("invalid option label");
        return {
          label: opt.label,
          description: typeof opt.description === "string" ? opt.description : undefined,
        };
      });
      if (options.length === 0) throw new Error("no options");
      return {
        question: item.question,
        header: typeof item.header === "string" ? item.header : undefined,
        multiSelect: item.multiSelect === true,
        options,
      };
    });
    return { questions };
  } catch {
    return undefined;
  }
}

// agent定義（.claude/agents/**/*.md）の frontmatter から model / effort を読む。
// 表示用の宣言値であり、orchestration の hook 観測値とは混ぜない（R-ORC-07）。
// SDK AgentDefinition（sdk.d.ts）の effort は名前付きレベルまたは整数。
// 値の妥当性検証はどちらの側でもしない（不正値は CLI が黙って無視するが、UI は宣言値を
// そのまま表示する。実効値との食い違いは許容）。
interface AgentDefInfo {
  model?: string;
  effort?: string;
}

function parseAgentFrontmatter(text: string): { name?: string } & AgentDefInfo {
  const out: { name?: string; model?: string; effort?: string } = {};
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const m = /^(name|model|effort):\s*(.+?)\s*$/.exec(lines[i]);
    if (m) out[m[1] as "name" | "model" | "effort"] = m[2];
  }
  return out;
}

// user(~/.claude/agents) → project(<cwd>/.claude/agents) の順に読み、project を優先する
// （CLI の探索順に合わせる）。サブディレクトリ1階層まで見る（実運用でグループ分けされている）。
// SDK options.agents（プログラム定義）とプラグイン由来の agent は対象外＝effort 不明として扱う。
function loadAgentDefs(cwd: string, log: (msg: string) => void): Map<string, AgentDefInfo> {
  const defs = new Map<string, AgentDefInfo>();
  for (const root of [join(claudeConfigDir(), "agents"), join(cwd, ".claude", "agents")]) {
    const files: string[] = [];
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) files.push(join(root, entry.name));
        else if (entry.isDirectory()) {
          try {
            for (const sub of readdirSync(join(root, entry.name), { withFileTypes: true })) {
              if (sub.isFile() && sub.name.endsWith(".md")) files.push(join(root, entry.name, sub.name));
            }
          } catch {
            // サブディレクトリ読み取り失敗は無視（定義なし扱い）
          }
        }
      }
    } catch {
      continue; // ディレクトリ自体が無いのは通常状態
    }
    for (const file of files) {
      try {
        const fm = parseAgentFrontmatter(readFileSync(file, "utf8"));
        const name = fm.name ?? file.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/, "");
        defs.set(name, { model: fm.model, effort: fm.effort });
      } catch (e) {
        log(`agent def read error: ${file}: ${String(e)}`);
      }
    }
  }
  return defs;
}

// 手動ハンドオフが使う SDK と起動環境。ClaudeConversation.start と
// 同じ require 経路・同じ buildClaudeEnv / resolveClaudeCodeStartup を通す。別経路で
// process.env をそのまま渡すと apiKeyPolicy を素通りして ANTHROPIC_API_KEY が子プロセスへ漏れる
export async function resolveHandoffRuntime(
  configuredExecutablePath: string | undefined,
  apiKeyPolicy?: ApiKeyPolicy
): Promise<{
  sdk: Pick<typeof ClaudeCodeSdk, "forkSession" | "query">;
  claudeExecutablePath: string;
  env: NodeJS.ProcessEnv;
}> {
  const sdk = require("@anthropic-ai/claude-agent-sdk") as Pick<
    typeof ClaudeCodeSdk,
    "forkSession" | "query"
  >;
  const startup = await resolveClaudeCodeStartup(configuredExecutablePath, sdkClaudeCodeVersion());
  const { env } = buildClaudeEnv(process.env, apiKeyPolicy); // R-GW-05
  return { sdk, claudeExecutablePath: startup.executable.path, env };
}

function normalizeLearningModel(value: string | undefined, context: ClaudeHostOptions): string | undefined {
  const clean = (model: string) => model.trim().toLowerCase().replace(/\[1m\]$/, "");
  const known = value ? clean(value) : undefined;
  const models = context.externalModels?.claude;
  const resolved = models?.state === "ok" ? models.models.find(row => clean(row.id) === known)?.resolvedModel : undefined;
  const model = resolved ?? (known && !/^(default|haiku|sonnet|opus)$/.test(known) ? known : context.configuredResolvedModel);
  const normalized = model ? clean(model) : undefined;
  return normalized && !/^(default|haiku|sonnet|opus)$/.test(normalized) ? normalized : undefined;
}

function learningModelsR12(context: ClaudeHostOptions, observed?: string) {
  const clean = (model: string) => model.trim().toLowerCase().replace(/\[1m\]$/, "");
  const known: Array<{ executor: ExecutorId; model: string }> = [], unresolved: Array<{ executor: ExecutorId; model: string }> = [];
  for (const executor of ["claude", "codex", "agy"] as const) {
    const list = context.externalModels?.[executor];
    if (list?.state !== "ok") continue;
    for (const row of list.models) {
      const id = clean(row.id);
      if (row.resolvedModel) known.push({ executor, model: clean(row.resolvedModel) });
      if (executor === "claude" && /^(default|haiku|sonnet|opus)$/.test(id)) unresolved.push({ executor, model: id });
      else known.push({ executor, model: id }, ...(executor === "agy" ? [{ executor, model: splitAgyModel(id).model }] : []));
    }
  }
  for (const model of [normalizeLearningModel(context.model, context), observed]) if (model) known.push({ executor: "claude", model });
  return { known, unresolved };
}

export class ClaudeConversation {
  private readonly externalRows: readonly ExternalRow[];
  private readonly externalTimeoutMinutes: number;
  private readonly runs: OrchestrationRunRecord[] = [];
  private readonly agentRuns = new Map<string, AgentRunRecord>();
  get orchestrationRuns(): readonly OrchestrationRunRecord[] { return Object.freeze([...this.runs]); }
  get observedAgentRuns(): ReadonlyMap<string, AgentRunRecord> { return new Map(this.agentRuns); }
  private async recordRun(record: OrchestrationRunRecord): Promise<OrchestrationRunRecord> {
    const index = this.runs.length;
    this.runs.push(record);
    if (this.opts.orchestrationRunsDirectory) {
      try { await appendRunRecord(this.opts.orchestrationRunsDirectory, record); }
      catch (error) {
        record = Object.freeze({ ...record, outcome: "failed", reason: [record.reason,
          runFailureReason("R-ORC-14: could not append orchestration run record", error)].filter(Boolean).join("; ") });
        this.runs[index] = record;
      }
    }
    if (record.reason) this.opts.log(record.reason);
    this.opts.onOrchestrationChanged?.();
    return record;
  }
  private readonly roster: readonly OrchestrationRow[];
  private readonly orchestrationEnabled: boolean;
  private readonly conductorPolicy: string;
  private readonly initialOrchestrationSettings: { settings: unknown; deliveredSetHash?: string };
  private learningDelivery?: Extract<LearningRecord, { kind: "delivery" }>;
  private learningSessionRef?: string;
  private learningState?: LearningState;
  private learningService?: LearningService;
  private learningGate?: LearningRootGate;
  private learningDeliveryRecorded = false;
  private learningMismatchRecorded = false;
  private learningPendingModels: string[] = [];
  private learningObservedModel?: string;
  private learningObservation: Promise<void> = Promise.resolve();
  private readonly observedAgents = new Map<string, Readonly<{ agentType?: string; model?: string; effort?: string }>>();

  get orchestrationRoster(): readonly OrchestrationRow[] { return this.roster; }
  get orchestrationActive(): boolean { return this.orchestrationEnabled; }
  get orchestrationExternalRoster(): readonly ExternalRow[] { return this.externalRows; }

  get learningFacts(): LearningFacts | undefined {
    // R-LRN-09: unavailable learning records must not become observed empty records.
    if (!this.learningFileR33() || !this.learningState) return undefined;
    const state = this.learningDelivery && !this.learningDeliveryRecorded
      ? { ...this.learningState, records: new Map(this.learningState.records).set(this.learningDelivery.opId, this.learningDelivery) }
      : this.learningState;
    return learningFacts(state, {
      conversationRef: this.conversationId,
      sessionRef: this.learningSessionRef ?? this.opts.resumeSessionId ?? null,
      model: this.learningObservedModel ?? this.learningDelivery?.model ?? null,
      scope: this.opts.learningScope ?? "global",
    });
  }

  private orchestrationSettings(options: Partial<ClaudeHostOptions>): unknown {
    return { enabled: options.orchestrationEnabled === true, agents: options.orchestrationAgents ?? [],
      learningEnabled: options.learningEnabled === true,
      timeout: options.externalTimeoutMinutes ?? 10,
      policy: options.conductorPolicy ?? "" };
  }

  orchestrationSettingsChanged(options: Partial<ClaudeHostOptions>): boolean {
    return !isDeepStrictEqual(this.initialOrchestrationSettings, {
      settings: this.orchestrationSettings(options), deliveredSetHash: this.initialOrchestrationSettings.deliveredSetHash,
    });
  }

  private learningFileR33(): string | undefined {
    if (this.opts.learningEnabled !== true) return undefined;
    return this.opts.learningDirectory ? join(this.opts.learningDirectory, "records.jsonl") : undefined;
  }

  private async appendLearningTransitionR33(transition: LearningTransition): Promise<boolean> {
    const file = this.learningFileR33();
    if (!file || !this.learningState) return false;
    const admitted = await this.learningService!.transition(transition);
    if (!admitted.ok) {
      this.opts.log(`R-LRN-07: learning admission refused: ${admitted.reason}`);
      return false;
    }
    return true;
  }

  private async prepareLearningDeliveryR31(): Promise<string> {
    const file = this.learningFileR33();
    if (!file) return "";
    try {
      this.learningService = sharedLearningService(file);
      if (!await this.learningService.load()) throw new Error("R-LRN-07: store-error");
      const state = this.learningState = this.learningService.state!;
      if (this.learningService.skipped) this.opts.log(`R-LRN-07: learning skipped ${this.learningService.skipped} records`);
      const scope = this.opts.learningScope ?? "global";
      for (const [ruleId, rule] of state.rules) for (const version of rule.versions) {
        if (version.record.scope !== scope) continue;
        for (const [model, qualification] of version.qualifications) {
          if (qualification.state === "quarantined" && qualification.reviewDueAt && Date.parse(qualification.reviewDueAt) <= Date.now()) {
            await this.appendLearningTransitionR33({ kind: "reviewDue", at: new Date().toISOString(),
              opId: textHash(`reviewDue:${ruleId}:${version.record.hash}:${model}:${qualification.reviewDueAt}`), rule_id: ruleId, model });
          }
        }
      }
      const model = normalizeLearningModel(this.opts.model, this.opts);
      if (!model) return "";
      if ([...state.records.values()].filter(record => record.kind === "control").at(-1)?.autoApply === false) return "";
      const selection = selectDelivery(state, { model, scope });
      this.learningDelivery = { kind: "delivery", at: new Date().toISOString(), opId: randomUUID(),
        conversationRef: this.conversationId, sessionRef: this.opts.resumeSessionId ?? null, model, scope,
        rules: selection.rules.map(({ ruleId, hash }) => ({ ruleId, hash })), setHash: selection.setHash, outcome: "sent" };
      const admitted = admitTransition(state, this.learningDelivery);
      if (!admitted.ok) throw new Error(admitted.reason);
      this.initialOrchestrationSettings.deliveredSetHash = selection.setHash;
      if (selection.overflow > 0) this.opts.log(`R-LRN-05: learning delivery overflow ${selection.overflow}; retained for review`);
      return renderDeliverySection(selection);
    } catch (error) {
      this.learningDelivery = undefined;
      this.learningState = this.learningService?.state;
      this.opts.log(runFailureReason("R-LRN-07: could not prepare learning delivery", error));
      return "";
    }
  }

  private recordLearningR12(input: unknown, rootVerified: boolean): Promise<LearningResult> {
    if (!rootVerified) this.opts.log("R-LRN-12: learning admission refused: caller-unverified");
    if (!this.learningService) return Promise.resolve(rootVerified ? { ok: false, code: "store-error", requirement: "R-LRN-07" }
      : { ok: false, code: "caller-unverified", requirement: "R-LRN-12" });
    const models = learningModelsR12(this.opts, this.learningObservedModel);
    return this.learningService.record(input, { enabled: this.opts.learningEnabled === true, rootVerified,
      conversationRef: this.conversationId, scope: this.opts.learningScope ?? "global",
      knownModels: models.known, unresolvedModels: models.unresolved, sourceRefs: [] });
  }

  private queueLearningR33(action: () => Promise<void>): Promise<void> {
    this.learningObservation = this.learningObservation.then(action).catch(error => {
      this.opts.log(runFailureReason("R-LRN-04 R-LRN-07: could not append learning record", error));
    });
    return this.learningObservation;
  }

  private recordLearningDeliveryR31(closing = false): Promise<void> {
    return this.queueLearningR33(async () => {
      const sent = this.learningDelivery;
      const sessionRef = this.learningSessionRef ?? this.opts.resumeSessionId ?? null;
      if (!sent || this.learningDeliveryRecorded || (!sessionRef && !closing)) return;
      if (!await this.appendLearningTransitionR33({ ...sent, sessionRef })) return;
      this.learningDeliveryRecorded = true;
      for (const model of this.learningPendingModels.splice(0)) await this.applyLearningModelR30(model);
    });
  }

  private observeLearningModelR30(model: string): Promise<void> {
    if (!this.learningState) return Promise.resolve();
    return this.queueLearningR33(async () => {
      const observed = normalizeLearningModel(model, this.opts);
      if (!observed) return;
      if (this.learningDelivery && !this.learningDeliveryRecorded) this.learningPendingModels.push(observed);
      else await this.applyLearningModelR30(observed);
    });
  }

  private async applyLearningModelR30(observed: string): Promise<void> {
    const state = this.learningState;
    if (!state) return;
    const previousObserved = this.learningObservedModel;
    this.learningObservedModel = observed;
    const scope = this.opts.learningScope ?? "global";
    const sessionRef = this.learningSessionRef ?? this.opts.resumeSessionId ?? null;
    const sent = this.learningDelivery;
    if (sent && observed !== sent.model && !this.learningMismatchRecorded) {
      this.learningMismatchRecorded = await this.appendLearningTransitionR33({ ...sent, at: new Date().toISOString(), opId: randomUUID(),
        sessionRef, model: observed, outcome: "model-mismatch" });
    }
    for (const [ruleId, rule] of state.rules) {
      const version = rule.versions.at(-1)!;
      if (version.record.scope !== scope || ![...version.qualifications.values()].some(value => value.state === "active")) continue;
      const last = [...state.records.values()].reverse().find(record =>
        record.kind === "delivery" && record.scope === scope && record.outcome === "sent"
          && record.rules.some(value => value.ruleId === ruleId && value.hash === version.record.hash)
        || record.kind === "quarantine" && record.rule_id === ruleId && record.hash === version.record.hash);
      const lastModel = last?.kind === "delivery" ? last.model : last?.kind === "quarantine" ? last.newModel : undefined;
      const oldModel = previousObserved ?? lastModel;
      if (oldModel && oldModel !== observed) {
        await this.appendLearningTransitionR33({ kind: "modelChange", at: new Date().toISOString(),
          opId: textHash(`quarantine:${ruleId}:${version.record.hash}:${oldModel}:${observed}:${this.conversationId}`),
          rule_id: ruleId, oldModel, newModel: observed, source: "conductor",
          conversationRef: this.conversationId, sessionRef, observationRef: randomUUID() });
      }
    }
  }

  get observedAgentSettings(): ReadonlyMap<string, Readonly<{ agentType?: string; model?: string; effort?: string }>> {
    return new Map(this.observedAgents);
  }

  private observeAgentSettings(input: unknown): void {
    if (!input || typeof input !== "object") return; // R-ORC-07
    const value = input as Record<string, unknown>;
    if (typeof value.agent_id !== "string" || !value.agent_id) return; // R-ORC-07: parent hooks carry parent effort.
    const previous = this.observedAgents.get(value.agent_id);
    const effort = value.effort as { level?: unknown } | undefined;
    this.observedAgents.set(value.agent_id, Object.freeze({
      agentType: typeof value.agent_type === "string" ? value.agent_type : previous?.agentType,
      model: typeof value.model === "string" ? value.model : previous?.model,
      effort: typeof effort?.level === "string" ? effort.level : previous?.effort,
    }));
  }

  readonly conversationId = randomUUID();
  lastRecordReceivedAt: number | undefined;
  private normalizer: ClaudeLiveNormalizer;
  private readonly usageLimitResume: UsageLimitResume;
  private readonly unsubscribeAutoContinue: () => void;
  private inputQueue: SDKUserMessage[] = [];
  private inputWaiter: (() => void) | null = null;
  private closed = false;
  private q: QueryHandle | null = null;
  private contextUsageInFlight = false;
  private contextUsagePending = false;
  private contextUsageGeneration = 0;
  private abortController = new AbortController();
  private pendingApprovals = new Map<string, PendingApproval>();
  private runLoopDone: Promise<void> | null = null;
  private inputGen: AsyncGenerator<SDKUserMessage> | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private agentDefs: Map<string, AgentDefInfo> | null = null;
  private cliCapabilities: string[] | null = null;

  constructor(private readonly opts: ClaudeHostOptions) {
    this.usageLimitResume = new UsageLimitResume({
      now: Date.now,
      random: Math.random,
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      enabled: () => readClaudeCodeSettings(true).autoContinueAtUsageLimit !== false,
      live: () => this.q !== null && !this.closed && this.state === "idle" && this.inputQueue.length === 0,
      send: (text) => this.send(text, undefined, undefined, true),
      notify: (event) => this.emit(event),
    });
    this.unsubscribeAutoContinue = onAutoContinueSettingChange(() => {
      if (readClaudeCodeSettings(true).autoContinueAtUsageLimit === false) this.cancelAutoResume();
    });
    this.initialOrchestrationSettings = { settings: structuredClone(this.orchestrationSettings(opts)), deliveredSetHash: undefined };
    this.orchestrationEnabled = opts.orchestrationEnabled === true;
    const resolved = resolveOrchestrationRoster(this.orchestrationEnabled ? opts.orchestrationAgents : []);
    this.roster = resolved.roster;
    this.externalRows = orchestrationExternalTargets(this.roster, opts.externalModels, opts.log);
    this.externalTimeoutMinutes = isExternalTimeout(opts.externalTimeoutMinutes) ? opts.externalTimeoutMinutes : 10;
    this.conductorPolicy = opts.conductorPolicy ?? "";
    for (const dropped of resolved.droppedRows) opts.log(dropped);
    this.normalizer = new ClaudeLiveNormalizer({
      cwd: this.opts.cwd,
      initialObservedTimestamp: this.opts.initialObservedTimestamp,
      log: this.opts.log,
      loadAgentDef: (subagentType: string) => this.loadAgentDef(subagentType),
      emit: (body, meta) => this.emit(body, meta),
      onTurnEnd: () => {
        if (this.interruptTimer) {
          clearTimeout(this.interruptTimer);
          this.interruptTimer = null;
        }
        for (const [requestId, p] of this.pendingApprovals) {
          p.resolve({ behavior: "deny" });
          this.emit({ kind: "approval_resolved", requestId, behavior: "deny", resolvedBy: "turn-end" });
        }
        this.pendingApprovals.clear();
        void this.requestContextUsage();
      },
      isClosed: () => this.closed,
    });
  }

  get initSlashCommands(): string[] | null {
    return this.normalizer.initSlashCommands;
  }

  get state(): "idle" | "running" | "interrupting" {
    return this.normalizer.turnState;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private loadAgentDef(subagentType: string): AgentDefInfo | undefined {
    this.agentDefs ??= loadAgentDefs(this.opts.cwd, this.opts.log);
    return this.agentDefs.get(subagentType);
  }

  async start(): Promise<void> {
    const sdk = require("@anthropic-ai/claude-agent-sdk") as Pick<
      typeof ClaudeCodeSdk,
      "query" | "USAGE_LIMIT_ERROR_PREFIXES" | "createSdkMcpServer" | "tool"
    >;
    const startup = await resolveClaudeCodeStartup(this.opts.claudeCodeExecutablePath, __LAISORA_SDK_CLAUDE_CODE_VERSION__);
    const resolvedExecutable = startup.executable;
    this.opts.log(`Claude Code executable resolved from ${resolvedExecutable.source}: ${resolvedExecutable.path}` + (resolvedExecutable.shimPath ? ` (npm shim: ${resolvedExecutable.shimPath})` : ""));
    const version = startup.version;
    this.opts.log(`Claude Code CLI version: ${version.cliVersion ?? "unavailable"}; SDK expected: ${__LAISORA_SDK_CLAUDE_CODE_VERSION__ ?? "unknown"}`);
    if (version.warning) this.opts.log(`[warning] ${version.warning}`);
    this.normalizer.setUsageLimitPrefixes([...sdk.USAGE_LIMIT_ERROR_PREFIXES]);

    const { env, removed } = buildClaudeEnv(process.env, this.opts.apiKeyPolicy);
    if (Object.entries(env).some(([key, value]) => envNameKey(key) === "ANTHROPIC_API_KEY" && typeof value === "string" && value.length > 0)) {
      this.opts.log("ANTHROPIC_API_KEY inherited by the child process (apiKeyPolicy=inherit)");
    }
    if (removed.length > 0) {
      this.opts.log(`env sanitized (removed: ${removed.join(", ")})`);
      if (removed.includes("ANTHROPIC_API_KEY")) {
        this.emit({
          kind: "error",
          message: l10n.t(
            "ANTHROPIC_API_KEY was present in the environment and was removed from the child process (subscription auth takes precedence)"
          ),
          fatal: false,
        });
      }
    }

    const self = this;
    const canUseTool: NonNullable<ClaudeCodeOptions["canUseTool"]> = async (
      toolName: string,
      input: Record<string, unknown>,
      ctx
    ): Promise<PermissionResult> => {
      // SDK が渡す文脈（blockedPath/decisionReason 等）も承認画面へ出す（codexレビューC1-8:
      // 解決済みパスや拒否理由を見ずに許可させない）。関数・AbortSignal 等は落として安全に直列化。
      const ctxJson = (() => {
        try {
          return JSON.stringify(
            ctx,
            (_k, v) => (typeof v === "function" || v instanceof AbortSignal ? undefined : v),
            2
          );
        } catch {
          return undefined;
        }
      })();
      const requestId = randomUUID();
      const rawInputJson = ctxJson
        ? `${JSON.stringify(input, null, 2)}
--- context ---
${ctxJson}`
        : JSON.stringify(input, null, 2);
      // AskUserQuestion（機能B）: 入力を安全にパースし質問カード用の構造を添える。
      // 形が想定外（SDKバージョン差異等）なら questions を付けず従来の生JSON表示にフォールバックする。
      const questions = toolName === "AskUserQuestion" ? parseAskUserQuestionInput(input) : undefined;
      self.emit({
        kind: "approval_request",
        turnId: self.normalizer.currentTurnId,
        requestId,
        toolName,
        rawInputJson,
        // 可読表示用: context を含まない純粋な入力JSONと、1行要約
        // 可読表示専用なので上限を設ける。rawInputJson と二重に載るため、巨大な Write の
        // content 等でイベントが倍化するのを防ぐ（超過時は inputSummary へフォールバック）
        inputJson: (() => {
          try {
            const s = JSON.stringify(input);
            return s.length <= 64_000 ? s : undefined;
          } catch {
            return undefined;
          }
        })(),
        inputSummary: summarizeToolInput(toolName, input) ?? undefined,
        expiresAt: null,
        questions,
      });
      // approval_resolved の emit は解決経路側（resolveApproval / endTurn / dispose）が単一責務で行う。
      // ここで emit すると turn-end/dispose 解決時に "user" の偽レコードが重複する（レビューR2-1）。
      const learningCall = toolName === LEARNING_TOOL_NAME ? ctx.toolUseID : undefined;
      self.learningGate?.hold(learningCall);
      if (learningCall !== undefined) {
        if (ctx.signal.aborted) self.learningGate?.revoke(learningCall);
        else ctx.signal.addEventListener("abort", () => self.learningGate?.revoke(learningCall), { once: true });
      }
      const decision = await self.opts.onApprovalRequest({ requestId, toolName, rawInputJson });
      if (decision.behavior === "deny") self.learningGate?.revoke(learningCall);
      else self.learningGate?.release(learningCall);
      if (decision.behavior === "deny") {
        return { behavior: "deny", message: l10n.t("Denied by the LAISORA user") };
      }
      // answers 形式は SDK の AskUserQuestionInput.answers（sdk-tools.d.ts）:
      // { [question: string]: string }（multiSelect はカンマ区切り）に合わせる。answers 無しの
      // allow（AskUserQuestion 以外の通常ツール）は従来通り input をそのまま返す。
      return decision.answers
        ? { behavior: "allow", updatedInput: { ...input, answers: decision.answers } }
        : { behavior: "allow", updatedInput: input };
    };

    const options: ClaudeCodeOptions = {
      cwd: this.opts.cwd,
      permissionMode: this.opts.permissionMode,
      settingSources: this.opts.settingSources,
      // flag settings 層（利用者設定より優先）へ載せる。~/.claude/settings.json は変更しないので
      // LAISORA 以外のセッションの Remote Control には影響しない
      settings: { remoteControlAtStartup: this.opts.remoteControlAtStartup === true, ...SDK_AUTO_CONTINUE_SETTINGS },
      includePartialMessages: true,
      pathToClaudeCodeExecutable: resolvedExecutable.path,
      canUseTool,
      abortController: this.abortController,
      env,
      stderr: (data: string) => this.opts.log(`[claude stderr] ${data}`),
    };
    // instrument: in-process MCP server（別プロセス無し）で progress を注入する。
    // 許可は allowedTools への事前登録で行う。SDK 仕様上 bare allowedTools は canUseTool より
    // 先に当該ツールを自動許可する（Transport Spike 実測）。progress は no-op で書込み・実行
    // 効果を持たないため事前許可が承認境界を侵さない
    if (this.opts.progressTracking === "instrument") {
      options.mcpServers = {
        ...(options.mcpServers ?? {}),
        laisora_progress: sdk.createSdkMcpServer({
          name: "laisora_progress",
          tools: [
            sdk.tool(
              "progress",
              "Report task progress (no-op recorder)",
              {
                pp: z.string(),
                task_id: z.string(),
                state: z.string(),
                activity: z.string().optional(),
                blocker: z.string().optional(),
                evidence: z.array(z.string()).optional(),
                next: z.string().optional(),
              },
              async () => ({ content: [{ type: "text" as const, text: "ok" }] })
            ),
          ],
        }),
      };
      options.allowedTools = [...(options.allowedTools ?? []), PROGRESS_WIRE_TOOL_NAME];
      // pp1 は SubagentStart hook の additionalContext で subagent へ直接渡す（Step 4a 実測）。
      // root へ入れて中継させる方式はモデル依存で成立しなかった。hook 入力は task 情報を
      // 持たないため task_id は書かせず、Host が Assignment から逆引きする
      options.hooks = {
        ...(options.hooks ?? {}),
        SubagentStart: [
          ...((options.hooks?.SubagentStart as unknown[] | undefined) ?? []),
          {
            hooks: [
              async () => ({
                hookSpecificOutput: {
                  hookEventName: "SubagentStart" as const,
                  additionalContext: PROGRESS_PROTOCOL_SPEC_PP1,
                },
              }),
            ],
          },
        ],
      } as ClaudeCodeOptions["hooks"];
    }
    if (this.opts.planInstruction !== false) {
      options.allowedTools = [...(options.allowedTools ?? []), "TaskCreate", "TaskGet", "TaskUpdate", "TaskList"];
    }
    options.systemPrompt = conversationSystemPrompt(this.opts.fileLinkInstruction === true, this.opts.planInstruction !== false);
    const deliverySection = await this.prepareLearningDeliveryR31();
    if (this.orchestrationEnabled) {
      options.agents = orchestrationAgents(this.roster);
      const base = this.opts.fileLinkInstruction === true ? FILE_LINK_INSTRUCTION : "";
      options.systemPrompt = { type: "custom", snapshot: false,
        prompt: [base, this.opts.planInstruction !== false ? PLAN_INSTRUCTION : "", conductorInstruction(this.roster, this.conductorPolicy, this.externalRows, deliverySection)].filter(Boolean).join("\n\n") };
      const observe: ClaudeCodeSdk.HookCallback = async (input) => {
        this.observeAgentSettings(input);
        const record = observeAgentRun(this.agentRuns.get((input as { agent_id?: string }).agent_id ?? ""), input);
        if (record) {
          this.agentRuns.set(record.agent_id, record);
          if (input.hook_event_name === "SubagentStop") await this.recordRun(record);
        }
        this.opts.onOrchestrationChanged?.();
        return {};
      };
      options.hooks = {
        ...(options.hooks ?? {}),
        SubagentStart: [...(options.hooks?.SubagentStart ?? []), { hooks: [observe] }],
        PreToolUse: [...(options.hooks?.PreToolUse ?? []), { hooks: [observe] }],
        SubagentStop: [...(options.hooks?.SubagentStop ?? []), { hooks: [observe] }],
      };
    }
    if (this.orchestrationEnabled && this.externalRows.length > 0) { // R-ORC-10
      options.mcpServers = { ...(options.mcpServers ?? {}), laisora_external: sdk.createSdkMcpServer({
        name: "laisora_external", timeout: this.externalTimeoutMinutes * 60_000 + 10_000,
        tools: [sdk.tool("run", externalDescription(this.externalRows), {
          target: z.string(), prompt: z.string(), files: z.array(z.string()).optional(), diff: z.string().optional(), cwd: z.string().optional(),
        }, async (input) => {
          const row = this.externalRows.find((entry) => entry.target === input.target);
          if (!row) return { isError: true, content: [{ type: "text" as const, text: "R-ORC-10: target is not in the conversation snapshot." }] };
          const run = await runExternal(row, input, { cwd: this.opts.cwd, timeoutMinutes: this.externalTimeoutMinutes, apiKeyPolicy: this.opts.apiKeyPolicy });
          const record = await this.recordRun(run.record);
          if (record !== run.record) return { isError: true, content: [{ type: "text" as const, text: record.reason! }] }; // R-ORC-14
          return run.result;
        })],
      }) };
    }
    if (this.opts.learningEnabled === true) {
      const prompt = options.systemPrompt as { type: "custom"; snapshot: false; prompt: string };
      options.systemPrompt = { ...prompt, prompt: [prompt.prompt, !this.orchestrationEnabled ? deliverySection : "", LEARNING_INSTRUCTION].filter(Boolean).join("\n\n") };
      const gate = this.learningGate = new LearningRootGate();
      options.mcpServers = { ...(options.mcpServers ?? {}), laisora_learning: createLearningMcpServer(sdk, gate, (input, root) => this.recordLearningR12(input, root)) };
      const gated = { matcher: LEARNING_TOOL_NAME, hooks: [gate.hook] };
      options.hooks = { ...(options.hooks ?? {}),
        PreToolUse: [...(options.hooks?.PreToolUse ?? []), gated],
        PermissionDenied: [...(options.hooks?.PermissionDenied ?? []), gated],
        PostToolUseFailure: [...(options.hooks?.PostToolUseFailure ?? []), gated] };
    }
    if (this.opts.model) options.model = this.opts.model;
    if (this.opts.effort) options.effort = this.opts.effort;
    if (this.opts.resumeSessionId) options.resume = this.opts.resumeSessionId;
    if (this.opts.permissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }

    this.inputGen = this.inputGenerator();
    this.q = sdk.query({
      prompt: this.inputGen as unknown as AsyncIterable<Parameters<typeof sdk.query>[0]["prompt"] extends AsyncIterable<infer Message> ? Message : never>,
      options,
    }) as QueryHandle;

    await this.recordLearningDeliveryR31();
    this.emit({ kind: "conversation_opened", cwd: this.opts.cwd, model: this.opts.model });
    void this.requestContextUsage();
    this.runLoopDone = this.runLoop();
  }

  private async *inputGenerator(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      while (this.inputQueue.length > 0) {
        const next = this.inputQueue.shift()!;
        // 診断ログ: steering入力が実際にSDKへ送出された時刻を残す（届いていないのか、
        // 届いた上でモデルが無視したのかを事後に切り分けるため）
        const head = next.message.content.find((b) => b.type === "text");
        this.opts.log(
          `input yield: state=${this.normalizer.turnState} text="${(head && "text" in head ? head.text : "").slice(0, 40)}"`
        );
        yield next;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.inputWaiter = resolve;
      });
    }
  }

  // Live Guardrail の steering envelope。型付き・非生成の投入経路で、
  // 宛先は実行中ターンだけ（idle は拒否）。startTurn を呼ばず shouldQuery も付けない
  // （モデルに読ませて行動させる）。失敗は NormalizedEvent にせず戻り値で返す（Guardrail は L2 非干渉）
  sendSteeringEnvelope(envelopeText: string): SteeringSendResult {
    // 受理検証は純粋関数（verify-guardrail が全分岐を直接検査する）。通らなければ inputQueue へ積まない
    const admission = admitSteeringSend(
      { closed: this.closed, turnState: this.normalizer.turnState },
      envelopeText,
      checkEnvelopeRedaction
    );
    if (!admission.ok) return admission;
    this.inputQueue.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: envelopeText }] },
      parent_tool_use_id: null,
      session_id: "",
    });
    this.inputWaiter?.();
    this.inputWaiter = null;
    return { ok: true };
  }

  // idle 投入でも startTurn を呼ばない: SDK 側が yield 受領時に自分で新ターンを起こす
  //（system:init の再発行を実測）。Host でも起こすと turn が二重に立つ。
  // send() は idle で startTurn を呼ぶので、見比べて「呼び忘れ」として足さないこと
  sendReportEnvelope(envelopeText: string): SteeringSendResult {
    const admission = admitReportSend(
      { closed: this.closed, turnState: this.normalizer.turnState },
      envelopeText,
      checkEnvelopeRedaction
    );
    if (!admission.ok) return admission;
    this.inputQueue.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: envelopeText }] },
      parent_tool_use_id: null,
      session_id: "",
    });
    this.inputWaiter?.();
    this.inputWaiter = null;
    return { ok: true };
  }

  cancelAutoResume(): void { this.usageLimitResume.cancel(); }

  send(text: string, images?: ImageAttachment[], observedTimestampSeed?: number, automatic = false): void {
    if (!automatic) this.usageLimitResume.manualSend();
    if (this.closed) {
      // interrupt強制終了直後の追加送信等。user_messageは記録済みのため無言ドロップにしない
      // （レビューAR2-4: 返答もエラーも来ない幽霊バブル化を防ぐ）
      this.emit({
        kind: "error",
        message: l10n.t("The conversation has ended. Resend your message (a new connection will be started)"),
        fatal: false,
      });
      return;
    }
    // 中断処理中の投入は受け付けない。ここで inputQueue へ積むと、強制終了フォールバック
    // （abort）が走ったときにキューごと捨てられ、ユーザーの指示が無言で消える。
    // provider interrupt が間に合った場合も、暗黙ターン分岐は turnState==="idle" を要求するため
    // 新ターンが開かれず、中断済みの旧 turnId に応答が帰属してしまう。
    // どちらも「送ったのに何も起きない」に見えるので、明示的に断って再送を促す。
    if (this.normalizer.turnState === "interrupting") {
      this.emit({
        kind: "error",
        message: l10n.t("Interrupt in progress. Stop first, then send again."),
        fatal: false,
      });
      return;
    }
    // steering: 実行中の追加送信は inputQueue へ直接投入する（新ターンは発行しない・turn_started
    // も emit しない）。SDK 側は現在ターンへの追加入力として扱う。turn_completed まで待たせない（CLI プロセスは複数入力を受け付ける）。
    const runningAlready = this.normalizer.turnState !== "idle";
    if (!runningAlready) {
      this.normalizer.seedObservedTimestamp(observedTimestampSeed);
      this.normalizer.startTurn(undefined, undefined, automatic);
    }
    // 画像は本文より前に置く。Anthropic API は画像を先に置いたほうが指示の解釈が安定する
    // （テキストが画像を参照する順序になる）。
    const content: UserContentBlock[] = [
      ...(images ?? []).map(
        (im): UserContentBlock => ({
          type: "image",
          source: { type: "base64", media_type: im.mediaType, data: im.data },
        })
      ),
      { type: "text", text },
    ];
    this.inputQueue.push({
      type: "user",
      message: { role: "user", content },
      ...(automatic ? { isMeta: true } : {}),
      parent_tool_use_id: null,
      session_id: "",
    });
    this.inputWaiter?.();
    this.inputWaiter = null;
  }

  // 中断プロトコル: 第一選択 provider API → タイムアウトで abort 強制終了。
  // タイマー解除は interrupt() RPC の ack ではなく「ターンが実際に終端した時」（endTurn）に行う。
  // ack はターン停止を意味しない（レビューR1-3）。
  async interrupt(): Promise<void> {
    this.cancelAutoResume();
    if (!this.q || this.normalizer.turnState !== "running") return;
    // 直接代入にする: メソッド経由だと TS が直前の turnState 判定の narrowing を保持し、
    // 後続の "interrupting" 比較を到達不能と誤判定する
    this.normalizer.turnState = "interrupting";
    const turnId = this.normalizer.currentTurnId;
    // steering滞留分の排出（H-1）: 中断開始時点で inputQueue に残っている未送出メッセージは、
    // 中断せずに投入すると新ターンとして実行されてしまう（中断したはずの指示が生き残る穴）。
    // 排出してユーザーに通知する。
    const drained = this.inputQueue.length;
    this.inputQueue = [];
    if (drained > 0) {
      this.emit({
        kind: "error",
        message: l10n.t("Discarded {0} unprocessed messages due to the interrupt", drained),
        fatal: false,
      });
    }
    // 中断開始時点で承認待ちを即deny失効させる（codexレビューC1-3:
    // 中断後に「許可」が押せて中断したはずのツールが実行される穴を塞ぐ）
    for (const [requestId, p] of this.pendingApprovals) {
      p.resolve({ behavior: "deny" });
      this.emit({ kind: "approval_resolved", requestId, behavior: "deny", resolvedBy: "interrupt" });
    }
    this.pendingApprovals.clear();
    const timeoutMs = this.opts.interruptForceKillTimeoutMs;
    this.interruptTimer = setTimeout(() => {
      if (this.normalizer.turnState === "interrupting" && this.normalizer.currentTurnId === turnId) {
        this.opts.log(`interrupt timeout (${timeoutMs}ms) → abort (force-kill fallback)`);
        this.abortController.abort();
        // abort 後の SDK teardown を待たず即座にターンを終端し、Conversation を閉鎖済みにする
        // （codexレビューC1-1/C2-1: 旧ターンの遅延 result が次ターンへ誤帰属する穴を、
        //   closed=true で「次の send は新 Conversation で」に倒して塞ぐ。result 側にもガードあり）
        this.endTurn("turn_interrupted");
        this.closed = true;
      }
    }, timeoutMs);
    // E2E #5 検証用: provider interrupt が効かないケースを再現し abort フォールバック経路を踏む
    if (this.opts.testInterruptHang) {
      this.opts.log("testInterruptHang: skipping provider interrupt (waiting for the timeout)");
      return;
    }
    try {
      const receipt = await this.q.interrupt({ cancelQueued: true });
      // uuid を付けずに送っているので、生き残った待機入力は receipt に列挙されない
      //（sdk.d.ts: uuid-less command は dequeue されるが列挙できない）。still_queued が
      // 空でも「何も走らない」証拠にはならないため、capability の有無で判断する
      const honorsCancelQueued = this.cliCapabilities?.includes(CAP_INTERRUPT_CANCEL_QUEUED) === true;
      const survivors = receipt?.still_queued?.length ?? 0;
      if (!this.closed && (!honorsCancelQueued || survivors > 0)) {
        this.opts.log(
          `interrupt: queued input may survive (${CAP_INTERRUPT_CANCEL_QUEUED}=${honorsCancelQueued}, still_queued=${survivors}) → abort (force-kill)`
        );
        this.abortController.abort();
        if (this.normalizer.turnState === "interrupting" && this.normalizer.currentTurnId === turnId) {
          this.endTurn("turn_interrupted");
        }
        this.closed = true;
      }
    } catch (e) {
      this.opts.log(`interrupt() error: ${String(e)} → abort fallback`);
      this.abortController.abort();
      // タイマー満了を待たず即終端（codexレビューC2-1: この経路だけ最大5秒残留していた）
      if (this.normalizer.turnState === "interrupting" && this.normalizer.currentTurnId === turnId) {
        this.endTurn("turn_interrupted");
        this.closed = true;
      }
    }
  }

  // 実行中の権限モード切替（SDK公式API。次のツール呼び出しから適用される）
  async setPermissionMode(
    mode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto" | "dontAsk"
  ): Promise<void> {
    if (!this.q || this.closed) return;
    await this.q.setPermissionMode(mode);
  }

  // スラッシュコマンド一覧（会話開始後に取得可能）
  async supportedCommands(): Promise<Array<{ name: string; description: string; aliases?: string[] }>> {
    if (!this.q || this.closed) return [];
    try {
      const cmds = await this.q.supportedCommands();
      return cmds.map((c) => ({
        name: c.name,
        description: c.description ?? "",
        aliases: parseAliases(c.aliases),
      }));
    } catch (e) {
      this.opts.log(`supportedCommands() error: ${String(e)}`);
      return [];
    }
  }

  private endTurn(
    kind: "turn_completed" | "turn_interrupted" | "turn_failed",
    extra?: {
      usage?: UsageSnapshot;
      reason?: string;
      errorKind?: "usage_limit";
      resetsAt?: number | null;
      detail?: string;
    }
  ): void {
    this.normalizer.endTurn(kind, extra);
  }

  private async runLoop(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const msg of this.q) {
        this.handleMessage(msg);
      }
      if (this.normalizer.turnState !== "idle") {
        this.endTurn(
          this.normalizer.turnState === "interrupting" ? "turn_interrupted" : "turn_failed",
          { reason: "backend_lost" }
        );
      }
      if (!this.closed) {
        this.closed = true;
        this.emit({ kind: "conversation_closed", reason: "backend_exited" });
      }
    } catch (e) {
      const aborted = this.abortController.signal.aborted;
      if (this.normalizer.turnState !== "idle") {
        this.endTurn(aborted ? "turn_interrupted" : "turn_failed", {
          reason: aborted ? undefined : String(e),
        });
      }
      if (!this.closed) {
        this.closed = true;
        this.emit({
          kind: "conversation_closed",
          reason: aborted ? "aborted" : `error: ${String(e)}`,
        });
      }
    } finally {
      await this.recordLearningDeliveryR31(true);
    }
  }

  private handleMessage(msg: any): void {
    // tool_progress は tool 実行中に 30 秒ごとに届く heartbeat（CLI 実測 2026-08-25）。出力の進捗を運ばないので活動に数えない。
    // root tool が開いている間の stagnation 抑止は guardrail.ts の isSuppressedByOpenTool が担う
    if (msg?.type !== "tool_progress") this.lastRecordReceivedAt = Date.now();
    if (msg?.type === "system" && msg?.subtype === "init" && Array.isArray(msg.capabilities)) {
      this.cliCapabilities = msg.capabilities.filter((c: unknown): c is string => typeof c === "string");
    }
    this.normalizer.handleMessage(msg);
  }

  private emit(
    ev: NormalizedEventBody & { provenance?: EventProvenance },
    meta?: NormalizedOutMeta
  ): void {
    if (ev.kind === "auth_status" && ev.auth?.sessionId) {
      this.learningSessionRef = ev.auth.sessionId;
      void this.recordLearningDeliveryR31(false);
    }
    this.opts.onEvent(ev, this.conversationId, meta);
    this.usageLimitResume.observe(ev);
    if (ev.kind === "conversation_closed") this.unsubscribeAutoContinue();
  }

  async dispose(): Promise<void> {
    this.cancelAutoResume();
    this.unsubscribeAutoContinue();
    if (this.inputQueue.length > 0) {
      this.opts.log(`dispose: ${this.inputQueue.length} unsent inputs remain`);
    }
    this.closed = true;
    this.learningGate?.clear();
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
    // 承認待ちの破棄は「拒否として解決 → 中断」の順
    for (const [requestId, p] of this.pendingApprovals) {
      p.resolve({ behavior: "deny" });
      this.emit({ kind: "approval_resolved", requestId, behavior: "deny", resolvedBy: "dispose" });
    }
    this.pendingApprovals.clear();
    this.inputWaiter?.();
    this.inputWaiter = null;
    try {
      if (this.normalizer.turnState === "running") await this.interrupt();
    } finally {
      this.abortController.abort();
    }
    // SDK が yield 中で inputWaiter を経由できない場合に備え generator を明示終了（レビューR1-9）
    try {
      await this.inputGen?.return(undefined as never);
    } catch {
      // no-op
    }
    if (this.runLoopDone) {
      await Promise.race([
        this.runLoopDone,
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
    await this.recordLearningDeliveryR31(true);
  }

  // 実行中のモデル切替（SDK公式API・ストリーミング入力モード限定）
  async setModel(model?: string): Promise<void> {
    if (!this.q || this.closed) return;
    // 実測でモデル切替直後に上限値が変わる（opus[1m] 1,000,000 → sonnet 967,000）。
    // 実行中の取得は旧モデルの上限を返すので、世代を進めて結果を捨て、切替後に取り直す。
    this.contextUsageGeneration += 1;
    try {
      await this.q.setModel(model);
    } finally {
      // 失敗時も取り直す。世代を進めた時点で実行中の取得結果は捨てられるため、
      // ここを成功時だけにすると切替に失敗したとき表示が更新されないまま残る。
      void this.requestContextUsage();
    }
  }

  async setEffort(effort: "low" | "medium" | "high" | "xhigh" | "max" | null): Promise<void> {
    if (!this.q || this.closed) throw new Error("Claude conversation is not connected");
    await this.q.applyFlagSettings({ effortLevel: effort });
  }

  // CLI が次のリクエストで使う model と effort（送信前でも resume の記録 model を反映する）。
  // effort: null = effort を送らない。戻り値 undefined・各キー undefined = 取得できない（古い CLI・切断・形の不一致）
  async appliedSettings(): Promise<
    { model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" | null } | undefined
  > {
    if (!this.q || this.closed || typeof this.q.getSettings !== "function") return undefined;
    try {
      const settings = await this.q.getSettings();
      const applied = typeof settings === "object" && settings !== null ? (settings as { applied?: unknown }).applied : undefined;
      if (typeof applied !== "object" || applied === null) return undefined;
      const { model, effort } = applied as { model?: unknown; effort?: unknown };
      if (typeof model === "string" && model.trim()) await this.observeLearningModelR30(model.trim());
      return {
        ...(typeof model === "string" && model.trim().length > 0 ? { model: model.trim() } : {}),
        ...(effort === null || effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max"
          ? { effort }
          : {}),
      };
    } catch (error) {
      this.opts.log(`getSettings failed: ${String(error)}`);
      return undefined;
    }
  }

  // 利用可能モデル一覧。SDKのフィールド名ゆらぎ(model/id/value)を吸収する
  async supportedModels(): Promise<Array<{ id: string; label: string; description: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }>> {
    if (!this.q || this.closed) return [];
    try {
      const models = await this.q.supportedModels();
      return models
        .map((m) => {
          const id = m.model ?? m.id ?? m.value ?? "";
          return { id, label: modelLabelWithVersion(m.displayName, id, m.resolvedModel), description: m.description ?? "",
            resolvedModel: m.resolvedModel, supportsEffort: m.supportsEffort, supportedEffortLevels: m.supportedEffortLevels };
        })
        .filter((m) => m.id.length > 0);
    } catch (e) {
      this.opts.log(`supportedModels() error: ${String(e)}`);
      return [];
    }
  }

  resolveApproval(requestId: string, behavior: "allow" | "deny", answers?: Record<string, string>): void {
    const p = this.pendingApprovals.get(requestId);
    if (p) {
      this.pendingApprovals.delete(requestId);
      // L-3: answers を反映するのは対応する承認が AskUserQuestion のときのみ（他ツールへの
      // なりすまし混入防止）。
      const useAnswers = behavior === "allow" && p.toolName === "AskUserQuestion" ? answers : undefined;
      p.resolve(behavior === "allow" ? { behavior, answers: useAnswers } : { behavior });
      this.emit({ kind: "approval_resolved", requestId, behavior, resolvedBy: "user", answers: useAnswers });
    }
  }

  registerPendingApproval(requestId: string, toolName: string, resolve: (r: ApprovalDecision) => void): void {
    this.pendingApprovals.set(requestId, { requestId, toolName, resolve });
  }

  // 表示の付随情報なので、呼び出し側は会話開始とターン終端を待たせないよう await しない。
  private async requestContextUsage(): Promise<void> {
    if (!this.q || this.closed) return;
    if (this.contextUsageInFlight) {
      this.contextUsagePending = true;
      return;
    }
    const q = this.q;
    const generation = this.contextUsageGeneration;
    this.contextUsageInFlight = true;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      // 実測最大2.35秒の制御リクエストが未解決でも、単一フライトが永久に塞がないよう余裕を持たせる。
      const usage = await Promise.race([
        q.getContextUsage(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("getContextUsage timeout")), 10_000);
        }),
      ]);
      if (this.closed || this.q !== q || this.contextUsageGeneration !== generation) return;
      if (
        !usage ||
        !Number.isFinite(usage.percentage) ||
        usage.percentage < 0 ||
        usage.percentage > 100 ||
        !Number.isFinite(usage.totalTokens) ||
        usage.totalTokens < 0 ||
        !Number.isFinite(usage.maxTokens) ||
        usage.maxTokens <= 0 ||
        (usage.autoCompactThreshold !== undefined &&
          (!Number.isFinite(usage.autoCompactThreshold) || usage.autoCompactThreshold < 0)) ||
        typeof usage.isAutoCompactEnabled !== "boolean"
      ) {
        this.opts.log("getContextUsage() returned invalid fields");
        return;
      }
      this.emit({
        kind: "context_usage",
        percentage: usage.percentage,
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        autoCompactThreshold: usage.autoCompactThreshold,
        isAutoCompactEnabled: usage.isAutoCompactEnabled,
      });
    } catch (e) {
      this.opts.log(`getContextUsage() error: ${String(e)}`);
    } finally {
      if (timeout) clearTimeout(timeout);
      const shouldRetry = this.contextUsagePending && !this.closed && this.q === q;
      this.contextUsagePending = false;
      this.contextUsageInFlight = false;
      if (shouldRetry) void this.requestContextUsage();
    }
  }
}
