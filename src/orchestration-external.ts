import { pathIsInside, realPathOrNearestSync } from "./path-containment";
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { buildClaudeEnv } from "./claude-env";
import { EXTERNAL_CAPABILITIES, externalExecutorName, isExternalRows, isExternalTimeout, type ExternalRow, type ExternalDetection, type ExternalModel, type ExternalModelList } from "./orchestration-roster";
import type { ApiKeyPolicy } from "./protocol";

export { isExternalRows, isExternalTimeout } from "./orchestration-roster";
export type { ExternalRow } from "./orchestration-roster";
import { EXECUTORS, EXTERNAL_EXECUTORS, isExternalExecutorId, isExternalModel, tokenUsage, type TokenUsage, type ExecutorProbe } from "./orchestration-executors";
export { tokenUsage, parseAgyModels, parseCodexModels } from "./orchestration-executors";
export type { TokenUsage } from "./orchestration-executors";
export interface ExternalRunRecord {
  readonly kind: "external";
  readonly cwd?: string;
  readonly role: string;
  readonly executor: ExternalRow["executor"];
  readonly model?: string;
  readonly effort?: ExternalRow["effort"];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly outcome: "ok" | "failed" | "timeout" | "refused";
  readonly reason?: string;
  readonly usage?: TokenUsage;
  readonly runId?: string;
  readonly sessionId?: string;
}
export interface AgentRunRecord {
  readonly kind: "agent";
  readonly agent_id: string;
  readonly firstSeenAt: string;
  readonly lastActivityAt: string;
  readonly outcome?: "failed";
  readonly reason?: string;
  readonly usage?: TokenUsage;
  readonly runId?: string;
  readonly sessionId?: string;
}
export type OrchestrationRunRecord = ExternalRunRecord | AgentRunRecord;
export type ExternalSpawn = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface ExternalDependencies {
  spawn?: ExternalSpawn;
  worktrees?: (cwd: string) => Promise<string[]>;
  commonDir?: (dir: string) => Promise<string | undefined>;
  resolve?: (executor: ExternalRow["executor"]) => string | undefined;
  killTree?: (pid: number) => Promise<void>;
  timeoutMs?: number;
}
export interface ExternalInput { target: string; prompt: string; files?: string[]; diff?: string; cwd?: string }

export function observeAgentRun(previous: AgentRunRecord | undefined, input: unknown, now = new Date().toISOString()): AgentRunRecord | undefined {
  if (!input || typeof input !== "object") return undefined; // R-ORC-15
  const value = input as Record<string, unknown>;
  if (typeof value.agent_id !== "string" || !value.agent_id) return undefined; // R-ORC-15
  return Object.freeze({ kind: "agent", agent_id: value.agent_id, firstSeenAt: previous?.firstSeenAt ?? now,
    lastActivityAt: now, usage: tokenUsage(value.usage) ?? previous?.usage });
}

export function orchestrationRunsDirectoryOf(globalStoragePath: string | undefined): string | undefined {
  return globalStoragePath ? join(globalStoragePath, "orchestration") : undefined;
}

export async function appendRunRecord(directory: string, record: OrchestrationRunRecord): Promise<void> {
  await mkdir(directory, { recursive: true });
  await appendFile(join(directory, "runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}

const OUTCOMES: readonly ExternalRunRecord["outcome"][] = ["ok", "failed", "timeout", "refused"];
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

// 既知のフィールドだけを取り出す。記録にある他のキーを素通しすると表示経路へ任意の値が載る（R-ORC-14）
export function decodeExternalRunRecord(raw: unknown): ExternalRunRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "external" || typeof r.role !== "string" || !/^[a-z][a-z0-9-]*$/.test(r.role) || !isExternalExecutorId(r.executor)) return undefined;
  if (!timestamp(r.startedAt) || !timestamp(r.endedAt) || typeof r.durationMs !== "number" || !Number.isFinite(r.durationMs) || r.durationMs < 0) return undefined;
  if (!OUTCOMES.includes(r.outcome as ExternalRunRecord["outcome"])) return undefined;
  if (r.model !== undefined && (!isExternalModel(r.model) || r.model === "")) return undefined;
  if (r.effort !== undefined && (typeof r.effort !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.effort))) return undefined;
  if ((r.cwd !== undefined && typeof r.cwd !== "string") || (r.reason !== undefined && typeof r.reason !== "string")) return undefined;
  if ((r.runId !== undefined && typeof r.runId !== "string") || (r.sessionId !== undefined && typeof r.sessionId !== "string")) return undefined;
  const usage = tokenUsage(r.usage);
  return Object.freeze({ kind: "external", ...(r.cwd !== undefined ? { cwd: r.cwd } : {}), role: r.role, executor: r.executor,
    ...(r.model !== undefined ? { model: r.model } : {}), ...(r.effort !== undefined ? { effort: r.effort as ExternalRunRecord["effort"] } : {}),
    startedAt: r.startedAt, endedAt: r.endedAt, durationMs: r.durationMs, outcome: r.outcome as ExternalRunRecord["outcome"],
    ...(r.reason !== undefined ? { reason: r.reason } : {}), ...(usage ? { usage } : {}),
    ...(r.runId !== undefined ? { runId: r.runId } : {}), ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}) });
}

export interface SessionExternalRuns {
  runs: ExternalRunRecord[];
  // 解析できない行と、この sessionId を名乗るのに形の合わない行。解析できない行はどのセッションのものか
  // 分からないので、読む全セッションで数える（R-DSP-01）
  unreadableLines: number;
  readError: boolean;
}

// sessionId を持たない行（キー導入前の記録）はどのセッションにも帰属させない
export async function readSessionExternalRuns(directory: string, sessionId: string): Promise<SessionExternalRuns> {
  let text: string;
  try {
    text = await readFile(join(directory, "runs.jsonl"), "utf8");
  } catch (error) {
    return { runs: [], unreadableLines: 0, readError: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  const runs: ExternalRunRecord[] = [];
  let unreadableLines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { unreadableLines++; continue; }
    if (!raw || typeof raw !== "object" || (raw as { sessionId?: unknown }).sessionId !== sessionId) continue;
    if ((raw as { kind?: unknown }).kind === "agent") continue;
    const run = decodeExternalRunRecord(raw);
    if (run) runs.push(run);
    else unreadableLines++;
  }
  return { runs, unreadableLines, readError: false };
}

export function resolveExternalExecutable(executor: ExternalRow["executor"], env = process.env, platform = process.platform): string | undefined {
  const get = (key: string) => Object.entries(env).find(([name]) => platform === "win32" ? name.toUpperCase() === key : name === key)?.[1];
  const names = platform === "win32" ? [`${executor}.exe`, `${executor}.cmd`, executor] : [executor];
  const directories = (get("PATH") ?? "").split(platform === "win32" ? ";" : delimiter).filter((dir) => isAbsolute(dir));
  const candidates = names.flatMap((name) => directories.map((dir) => join(dir, name)));
  const local = get("LOCALAPPDATA");
  if (platform === "win32" && local) candidates.push(...names.map((name) => join(local, ...EXECUTORS[executor].localPath!, name)));
  return candidates.find((candidate) => existsSync(candidate));
}

export function runFailureReason(reason: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // R-ORC-14: process errors can contain argv, including the private prompt.
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? `${reason} (${code})` : reason;
}

export function externalDescription(rows: readonly ExternalRow[]): string {
  return [`Run an external target using its exact target key. Optional cwd must be inside the conversation directory or a registered worktree of its repository. ${EXTERNAL_EXECUTORS.map((definition) => definition.displayName).join(" and ")} cost no Claude usage. ${EXTERNAL_CAPABILITIES}`, ...rows.filter((row) => row.enabled)
    .map(({ target, role, executor, model, effort, description }) => JSON.stringify({ target, role, executor: externalExecutorName(executor), model, effort, description }))].join("\n");
}

export function externalPrompt(executor: ExternalRow["executor"], input: ExternalInput, role?: string): string {
  if (input.files?.some((file) => !isAbsolute(file))) throw new Error("R-ORC-12: files must be absolute paths");
  const preamble = executor === "codex" && role === "worker"
    ? "You may edit files under the current directory. Do not commit, push, stash, or checkout. Do not run the build. Report the files you changed."
    : EXECUTORS[executor].preamble;
  return `${preamble}\nAllowed absolute file paths:\n${(input.files ?? []).map((file) => JSON.stringify(file)).join("\n")}\nDiff:\n${input.diff ?? ""}\nTask:\n${input.prompt}`;
}

export function externalArgv(row: ExternalRow, cwd: string, minutes: number, prompt: string): string[] {
  if (!isExternalRows([row]) || !isExternalTimeout(minutes) || !isAbsolute(cwd)) throw new Error("R-ORC-12: invalid executor settings");
  return EXECUTORS[row.executor].argv!(row.model, row.effort, cwd, minutes, prompt, row.role);
}
export function parseExternalOutput(executor: ExternalRow["executor"], output: string, exitCode: number | null): { outcome: ExternalRunRecord["outcome"]; answer: string; usage?: TokenUsage } {
  return EXECUTORS[executor].parseOutput!(output, exitCode);
}

export async function killExternalTree(pid: number, spawnChild: ExternalSpawn = spawn, platform = process.platform, killGroup = process.kill): Promise<void> {
  if (platform !== "win32") { try { killGroup(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } return; }
  await new Promise<void>((resolve, reject) => {
    const killer = spawnChild("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore", timeout: 5000 });
    killer.once("error", reject);
    killer.once("close", (code) => code === 0 ? resolve() : reject(new Error("Process tree termination failed")));
  });
}

export function externalLaunch(executable: string, args: string[], env: NodeJS.ProcessEnv, platform = process.platform) {
  if (platform !== "win32" || !executable.toLowerCase().endsWith(".cmd")) return { executable, args, env };
  // R-ORC-12: unwrap Node CLI shims without executing their shell text or interpolating the prompt.
  const script = readFileSync(executable, "utf8").match(/"%(?:dp0%|~dp0)[\\/]([^"\r\n]+\.(?:[cm]?js))"/i)?.[1];
  if (!script) throw new Error("R-ORC-12: unsupported executable shim");
  const entry = resolve(dirname(executable), script.replace(/\\/g, "/"));
  accessSync(entry, constants.F_OK);
  return { executable: process.execPath, args: [entry, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
}

async function capture(executable: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv, limit: number, deps: ExternalDependencies, maxOutput = Infinity) {
  return new Promise<{ output: string; code: number | null; timeout: boolean; reason?: string; spawnCode?: string }>((resolve) => {
    let output = "", settled = false, expired = false;
    let spawnCode: string | undefined;
    const captureSpawnCode = (error: unknown) => {
      const code = (error as NodeJS.ErrnoException)?.code;
      spawnCode = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "UNKNOWN";
    };
    let child: ChildProcess;
    let timer: ReturnType<typeof setTimeout>;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({ output, code, timeout: expired, reason, spawnCode });
    };
    try {
      const launch = externalLaunch(executable, args, env);
      child = (deps.spawn ?? spawn)(launch.executable, launch.args, { cwd, env: launch.env, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { captureSpawnCode(error); finish(null, runFailureReason("R-ORC-13: external executor launch failed", error)); return; }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (data) => { output = (output + data.toString()).slice(0, maxOutput); }); // R-ORC-12
    child.stderr?.on("data", () => {});
    child.once("error", (error) => { if (!expired) { captureSpawnCode(error); finish(null, runFailureReason("R-ORC-13: external executor process failed", error)); } });
    child.once("exit", (code) => {
      if (expired || settled) return; // R-ORC-13
      clearTimeout(timer);
      // R-ORC-13: descendants may keep pipes open after the executor has exited.
      if (!child.stdout || child.stdout.readableEnded) finish(code);
      else {
        child.stdout.once("end", () => finish(code));
        drainTimer = setTimeout(() => finish(code), 250);
      }
    });
    timer = setTimeout(() => {
      expired = true;
      void (async () => {
        try { if (child.pid) await (deps.killTree ?? killExternalTree)(child.pid); }
        catch (error) { finish(null, runFailureReason("R-ORC-11: external executor timed out; process tree termination failed", error)); return; }
        finish(null, "R-ORC-11: external executor timed out.");
      })();
    }, limit);
  });
}

export async function listExternalModels(executor: ExternalRow["executor"], policy?: ApiKeyPolicy, deps: ExternalDependencies = {}): Promise<ExternalModelList> {
  try {
    const executable = (deps.resolve ?? resolveExternalExecutable)(executor);
    if (!executable) return { state: "failed", reason: "not-installed" }; // R-ORC-12
    const env = buildClaudeEnv(process.env, policy).env; // R-GW-05
    const limit = Math.min(deps.timeoutMs ?? 10_000, 10_000);
    return await EXECUTORS[executor].listModels!(executorProbe(executable, env, limit, deps));
  } catch (error) { return { state: "failed", reason: runFailureReason("model-list-failed", error) }; }
}
function executorProbe(executable: string, env: NodeJS.ProcessEnv, limit: number, deps: ExternalDependencies): ExecutorProbe {
  return { path: executable, version: (require("../package.json") as { version: string }).version,
    capture: (args) => capture(executable, args, undefined, env, limit, deps, 1_000_001),
    rpc: (args, initialize, initialized, method, parse) => captureModelRpc(executable, env, limit, deps, args, initialize, initialized, method, parse) };
}
export async function detectExternalExecutor(executor: ExternalRow["executor"], policy?: ApiKeyPolicy, deps: ExternalDependencies = {}): Promise<ExternalDetection> {
  const path = (deps.resolve ?? resolveExternalExecutable)(executor);
  if (!path) return { state: "notInstalled" }; // R-ORC-20
  return EXECUTORS[executor].detect!(executorProbe(path, buildClaudeEnv(process.env, policy).env, deps.timeoutMs ?? 10_000, deps));
}
async function captureModelRpc(executable: string, env: NodeJS.ProcessEnv, limit: number, deps: ExternalDependencies,
  args: string[], initialize: object, initialized: object, method: string, parse: Parameters<ExecutorProbe["rpc"]>[4]): Promise<ExternalModelList> {
    return await new Promise<ExternalModelList>((resolveList) => {
      let child: ChildProcess | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false, buffer = "", received = 0, requestId = 1, pages = 0;
      const models: ExternalModel[] = [];
      const finishList = (result: ExternalModelList) => {
        if (settled) return; // R-ORC-12
        settled = true;
        clearTimeout(timer);
        void (async () => {
          try {
            if (child?.pid) await (deps.killTree ?? killExternalTree)(child.pid);
            resolveList(result);
          } catch (error) {
            let reason = runFailureReason("model-list-termination-failed", error);
            try { child?.kill?.(); } // R-ORC-12: still close the server when tree termination fails.
            catch (killError) { reason = runFailureReason(reason, killError); }
            resolveList({ state: "failed", reason });
          } finally {
            child?.stdin?.destroy();
            child?.stdout?.destroy();
            child?.stderr?.destroy();
          }
        })();
      };
      const failedList = (reason: string) => finishList({ state: "failed", reason });
      const sendList = (message: object) => {
        if (!child?.stdin?.writable) throw new Error("R-ORC-12: model-list stdin unavailable");
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) failedList("model-list-write-failed"); });
      };
      try {
        const launch = externalLaunch(executable, args, env);
        child = (deps.spawn ?? spawn)(launch.executable, launch.args, { env: launch.env, shell: false, windowsHide: true,
          detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
        timer = setTimeout(() => failedList("timeout"), limit);
        child.once("error", error => failedList((error as NodeJS.ErrnoException).code === "ENOENT" ? "not-installed" : "model-list-process-failed"));
        child.once("close", () => failedList("model-list-closed"));
        child.stdin?.on("error", () => failedList("model-list-write-failed"));
        child.stdout?.on("error", () => failedList("model-list-read-failed"));
        child.stderr?.on("error", () => failedList("model-list-read-failed"));
        child.stderr?.on("data", () => {});
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
          if (settled) return; // R-ORC-12
          buffer += chunk.toString();
          received += chunk.toString().length;
          if (received > 1_000_000) { failedList("model-list-too-large"); return; } // R-ORC-12
          try {
            let newline: number;
            while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (!line.trim()) continue;
              const response = JSON.parse(line);
              if (!response || typeof response !== "object") throw new Error("R-ORC-12: invalid response");
              if (response.id !== requestId) continue;
              if (response.error || !response.result) { failedList("model-list-rpc-failed"); return; } // R-ORC-12
              if (requestId === 1) {
                requestId = 2;
                sendList(initialized);
                sendList({ id: requestId, method, params: {} });
              } else {
                const page = parse(response.result);
                if (page.state === "failed") { finishList(page); return; } // R-ORC-12
                for (const model of page.models) if (models.length < 100 && !models.some((entry) => entry.id === model.id)) models.push(model);
                pages++;
                if (page.nextCursor !== null && pages < 5 && models.length < 100) {
                  sendList({ id: ++requestId, method, params: { cursor: page.nextCursor } });
                } else finishList(models.length ? { state: "ok", models } : { state: "failed", reason: "empty-model-list" });
              }
            }
          } catch (error) { failedList(runFailureReason("invalid-model-list-response", error)); }
        });
        sendList({ id: 1, ...initialize });
      } catch (error) { failedList((error as NodeJS.ErrnoException).code === "ENOENT" ? "not-installed" : runFailureReason("model-list-launch-failed", error)); }
    });
}

export async function registeredWorktrees(cwd: string): Promise<string[]> {
  return new Promise((resolveList) => {
    execFile("git", ["worktree", "list", "--porcelain", "-z"],
      { cwd, shell: false, windowsHide: true, encoding: "utf8", timeout: 5000 }, (error, stdout) => {
        resolveList(error ? [] : stdout.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9)));
      });
  });
}

export async function gitCommonDir(dir: string): Promise<string | undefined> {
  let existing = dir;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  return new Promise((done) => {
    execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: existing, shell: false, windowsHide: true, encoding: "utf8", timeout: 5000 }, (error, stdout) => {
        done(error ? undefined : stdout.trim() || undefined);
      });
  });
}

export async function resolveExternalCwd(conversationCwd: string, requested: string | undefined,
  worktrees = registeredWorktrees, commonDir = gitCommonDir): Promise<string> {
  if (requested !== undefined && (typeof requested !== "string" || !requested.trim())) {
    throw new Error("R-ORC-35: cwd must be a non-empty path.");
  }
  const candidate = realPathOrNearestSync(resolve(conversationCwd, requested ?? "."));
  const root = realPathOrNearestSync(conversationCwd);
  if (!candidate || !root) throw new Error("R-ORC-35: cwd real path could not be resolved.");
  if (pathIsInside(root, candidate)) return candidate;
  for (const registered of await worktrees(root)) {
    const real = realPathOrNearestSync(registered);
    if (real && pathIsInside(real, candidate)) return candidate;
  }
  // R-ORC-35: the conversation directory may hold nested repositories whose worktrees live elsewhere.
  const common = await commonDir(candidate);
  const main = common && basename(common).toLowerCase() === ".git" ? realPathOrNearestSync(dirname(common)) : undefined;
  if (main && pathIsInside(root, main)) {
    for (const registered of await worktrees(main)) {
      const real = realPathOrNearestSync(registered);
      if (real && pathIsInside(real, candidate)) return candidate;
    }
  }
  throw new Error("R-ORC-35: cwd is outside the conversation directory, its registered git worktrees, and worktrees of repositories inside it.");
}

export async function runExternal(row: ExternalRow, input: ExternalInput, options: { cwd: string; timeoutMinutes: number; apiKeyPolicy?: ApiKeyPolicy }, deps: ExternalDependencies = {}) {
  const started = Date.now();
  let parsed: ReturnType<typeof parseExternalOutput> = { outcome: "failed", answer: "R-ORC-13: external executor not found." };
  let args: string[];
  let cwd: string | undefined;
  try {
    cwd = await resolveExternalCwd(options.cwd, input.cwd, deps.worktrees, deps.commonDir);
  } catch (error) {
    parsed = { outcome: "refused", answer: error instanceof Error && error.message.startsWith("R-ORC-35:")
      ? error.message : "R-ORC-35: registered git worktrees could not be read." };
    return completedRun();
  }
  try {
    args = externalArgv(row, cwd, options.timeoutMinutes, externalPrompt(row.executor, input, row.role));
  } catch (error) {
    parsed = { outcome: "failed", answer: runFailureReason("R-ORC-12: invalid external executor input or settings.", error) };
    return completedRun();
  }
  try {
    const executable = (deps.resolve ?? resolveExternalExecutable)(row.executor);
    if (executable) {
      const result = await capture(executable, args, cwd, buildClaudeEnv(process.env, options.apiKeyPolicy).env,
        deps.timeoutMs ?? options.timeoutMinutes * 60_000, deps);
      parsed = result.timeout ? { outcome: "timeout", answer: result.reason ?? "External executor timed out." }
        : result.reason ? { outcome: "failed", answer: result.reason } : parseExternalOutput(row.executor, result.output, result.code);
    }
  } catch (error) {
    parsed = { outcome: "failed", answer: runFailureReason("R-ORC-13: external executor failed.", error) };
  }
  return completedRun();
  function completedRun() {
    const ended = Date.now();
    const record: ExternalRunRecord = Object.freeze({ kind: "external", ...(cwd ? { cwd } : {}), role: row.role, executor: row.executor, ...(row.model ? { model: row.model } : {}),
      ...(row.effort === undefined ? {} : { effort: row.effort }), startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: ended - started,
      outcome: parsed.outcome, reason: parsed.outcome === "ok" ? undefined : parsed.answer, usage: parsed.usage });
    return { record, result: { isError: parsed.outcome !== "ok", content: [{ type: "text" as const, text: parsed.answer }] } };
  }
}
