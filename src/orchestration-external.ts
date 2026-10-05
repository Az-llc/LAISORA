import { pathIsInside, realPathOrNearestSync } from "./path-containment";
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import type { PromptBudget } from "./learning-delivery";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { buildClaudeEnv } from "./claude-env";
import { EXTERNAL_CAPABILITIES, externalExecutorName, isExternalRows, isExternalTimeout, type ExternalRow, type ExternalDetection, type ExternalModel, type ExternalModelList } from "./orchestration-roster";
import type { ApiKeyPolicy } from "./protocol";

export { isExternalRows, isExternalTimeout } from "./orchestration-roster";
export type { ExternalRow } from "./orchestration-roster";
import { EXECUTORS, EXTERNAL_EXECUTORS, isExternalExecutorId, isExternalModel, tokenUsage, type TokenUsage, type ExecutorProbe } from "./orchestration-executors";
export { tokenUsage, parseAgyModels, parseCodexModels } from "./orchestration-executors";
export type { TokenUsage } from "./orchestration-executors";
export const LEARNING_ADDITION_CODE_POINT_CAP = 2000;
export const WINDOWS_COMMAND_LINE_UTF16_LIMIT = 32767;
export const DISPATCH_BUDGET_EXCEEDED = "R-LRN-35: task prompt exceeds executor dispatch budget";
export const DISPATCH_INTERNAL_ERROR = "R-LRN-35: internal error while preparing the task prompt; the call was not sent";
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
  readonly outcome: "ok" | "failed" | "timeout" | "refused" | "stopped";
  readonly reason?: string;
  readonly usage?: TokenUsage;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly conversation?: string;
  readonly recipient?: string;
  readonly dispatchId?: string;
  readonly requestedModel?: string;
  readonly requestedEffort?: string;
  readonly observedModel?: string;
  readonly observedEffort?: string;
  readonly attestation?: CodexAttestation;
}
export interface CodexAttestation {
  readonly source: "codex-turn-context";
  readonly sessionId: string;
  readonly model: string;
  readonly effort: string;
}
const codexSessionId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function decodeCodexAttestation(raw: unknown): CodexAttestation | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as CodexAttestation;
  return value.source === "codex-turn-context" && codexSessionId(value.sessionId) && isExternalModel(value.model) && value.model !== ""
    && EXECUTORS.codex.efforts.includes(value.effort) ? value : undefined;
}
export interface AgentRunRecord {
  readonly kind: "agent";
  readonly agent_id: string;
  readonly firstSeenAt: string;
  readonly lastActivityAt: string;
  readonly outcome?: "normal" | "stopped" | "timeout" | "unknown";
  readonly reason?: string;
  readonly usage?: TokenUsage;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly conversation?: string;
  readonly recipient?: string;
  readonly dispatchId?: string;
  readonly agentKey?: string;
  readonly role?: string;
  readonly requestedModel?: string;
  readonly requestedEffort?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly segment?: number;
  readonly outcomeEvidence?: readonly string[];
  readonly confirmedAt?: string;
}
export type OrchestrationRunRecord = ExternalRunRecord | AgentRunRecord;
export type ExternalSpawn = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface ExternalDependencies {
  preparePrompt?: (prompt: string, packaging: string, budget: PromptBudget) => string;
  onAccepted?: () => Promise<void> | undefined;
  spawn?: ExternalSpawn;
  worktrees?: (cwd: string) => Promise<string[]>;
  commonDir?: (dir: string) => Promise<string | undefined>;
  resolve?: (executor: ExternalRow["executor"]) => string | undefined;
  killTree?: (pid: number) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  codexHome?: string;
}
export interface ExternalInput { target: string; prompt: string; description?: string; files?: string[]; diff?: string; cwd?: string }

export function observeAgentRun(previous: AgentRunRecord | undefined, input: unknown, now = new Date().toISOString()): AgentRunRecord | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.agent_id !== "string" || !value.agent_id) return undefined;
  return Object.freeze({ ...previous, kind: "agent", agent_id: value.agent_id, firstSeenAt: previous?.firstSeenAt ?? now,
    lastActivityAt: now, usage: tokenUsage(value.usage) ?? previous?.usage });
}

export function orchestrationRunsDirectoryOf(globalStoragePath: string | undefined): string | undefined {
  return globalStoragePath ? join(globalStoragePath, "orchestration") : undefined;
}

export async function appendRunRecord(directory: string, record: OrchestrationRunRecord): Promise<void> {
  await mkdir(directory, { recursive: true });
  await appendFile(join(directory, "runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}

const OUTCOMES: readonly ExternalRunRecord["outcome"][] = ["ok", "failed", "timeout", "refused", "stopped"];
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

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
  for (const field of ["conversation", "recipient", "dispatchId", "requestedModel", "requestedEffort", "observedModel", "observedEffort"]) {
    if (r[field] !== undefined && (typeof r[field] !== "string" || !/^[A-Za-z0-9._:\[\]-]+$/.test(String(r[field])))) return undefined;
  }
  const attestation = r.executor === "codex" ? decodeCodexAttestation(r.attestation) : undefined;
  const attested = attestation && attestation.model === r.observedModel && attestation.effort === r.observedEffort;
  return Object.freeze({ kind: "external", ...(r.cwd !== undefined ? { cwd: r.cwd } : {}), role: r.role, executor: r.executor,
    ...(r.model !== undefined ? { model: r.model } : {}), ...(r.effort !== undefined ? { effort: r.effort as ExternalRunRecord["effort"] } : {}),
    startedAt: r.startedAt, endedAt: r.endedAt, durationMs: r.durationMs, outcome: r.outcome as ExternalRunRecord["outcome"],
    ...(r.reason !== undefined ? { reason: r.reason } : {}), ...(usage ? { usage } : {}),
    ...(r.runId !== undefined ? { runId: r.runId } : {}), ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.conversation !== undefined ? { conversation: r.conversation as string } : {}),
    ...(r.recipient !== undefined ? { recipient: r.recipient as string } : {}), ...(r.dispatchId !== undefined ? { dispatchId: r.dispatchId as string } : {}),
    requestedModel: (r.requestedModel ?? r.model ?? "unknown") as string,
    requestedEffort: (r.requestedEffort ?? r.effort ?? "unknown") as string,
    observedModel: attested ? attestation.model : "unknown", observedEffort: attested ? attestation.effort : "unknown",
    ...(attested ? { attestation } : {}) });
}

export interface SessionExternalRuns {
  runs: ExternalRunRecord[];
  unreadableLines: number;
  readError: boolean;
}

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
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? `${reason} (${code})` : reason;
}

export function externalDescription(rows: readonly ExternalRow[]): string {
  return [`Run an external target using its exact target key. Fill description with a short plain summary of the work being delegated for the status display; prompt remains the execution instructions. Optional cwd must be inside the conversation directory or a registered worktree of its repository. ${EXTERNAL_EXECUTORS.map((definition) => definition.displayName).join(" and ")} cost no Claude usage. ${EXTERNAL_CAPABILITIES}`, ...rows.filter((row) => row.enabled)
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
  const script = readFileSync(executable, "utf8").match(/"%(?:dp0%|~dp0)[\\/]([^"\r\n]+\.(?:[cm]?js))"/i)?.[1];
  if (!script) throw new Error("R-ORC-12: unsupported executable shim");
  const entry = resolve(dirname(executable), script.replace(/\\/g, "/"));
  accessSync(entry, constants.F_OK);
  return { executable: process.execPath, args: [entry, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
}

export function windowsCommandLineUnits(executable: string, args: readonly string[]): number {
  const quote = (arg: string) => !arg || /[\s"]/.test(arg)
    ? `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"` : arg;
  return [quote(executable), ...args.map(quote)].join(" ").length + 1;
}

export async function observeCodexSession(output: string, started: number, ended: number, directory = process.env.CODEX_HOME ?? join(homedir(), ".codex")): Promise<CodexAttestation | undefined> {
  const sessions = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    try { const event = JSON.parse(line); if (event.type === "thread.started" && codexSessionId(event.thread_id)) sessions.add(event.thread_id); }
    catch {}
  }
  if (sessions.size !== 1) return undefined;
  const sessionId = [...sessions][0];
  const days = new Set<string>();
  for (const time of [started - 86400_000, started, ended, ended + 86400_000]) days.add(new Date(time).toISOString().slice(0, 10).replace(/-/g, "/"));
  let observed: CodexAttestation | undefined;
  try {
    for (const day of days) {
      const folder = join(directory, "sessions", day);
      let files: string[];
      try { files = await readdir(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const file of files.filter(file => file.endsWith(`-${sessionId}.jsonl`))) {
        const text = await readFile(join(folder, file), "utf8");
        const lines = text.trimEnd().split(/\r?\n/).map(line => JSON.parse(line));
        if (lines[0]?.type !== "session_meta" || lines[0]?.payload?.id !== sessionId) continue;
        for (const line of lines) if (line.type === "turn_context") {
          const candidate = decodeCodexAttestation({ source: "codex-turn-context", sessionId, model: line.payload?.model, effort: line.payload?.effort });
          if (!candidate || observed && (candidate.model !== observed.model || candidate.effort !== observed.effort)) return undefined;
          observed = candidate;
        }
      }
    }
  } catch { return undefined; }
  return observed;
}

async function capture(executable: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv, limit: number, deps: ExternalDependencies, maxOutput = Infinity) {
  return new Promise<{ output: string; code: number | null; timeout: boolean; status: "exited" | "timeout" | "stopped" | "failed"; reason?: string; spawnCode?: string }>((resolve) => {
    let output = "", settled = false, terminating = false, exited = false;
    let spawnCode: string | undefined;
    const captureSpawnCode = (error: unknown) => {
      const code = (error as NodeJS.ErrnoException)?.code;
      spawnCode = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "UNKNOWN";
    };
    let child: ChildProcess;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, status: "exited" | "timeout" | "stopped" | "failed", reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      deps.signal?.removeEventListener("abort", onAbort);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({ output, code, timeout: status === "timeout", status, reason, spawnCode });
    };
    const terminate = (status: "timeout" | "stopped") => {
      if (settled || terminating || exited) return;
      terminating = true;
      clearTimeout(timer);
      void (async () => {
        try {
          if (!child.pid) throw new Error("external executor process id unavailable");
          await (deps.killTree ?? killExternalTree)(child.pid);
          finish(null, status, status === "timeout" ? "R-ORC-11: external executor timed out." : "R-ORC-13: external executor stopped.");
        } catch (error) {
          finish(null, status === "timeout" ? "timeout" : "failed", runFailureReason(
            status === "timeout" ? "R-ORC-11: external executor timed out; process tree termination failed" : "R-ORC-13: external executor stop failed; process tree termination failed", error));
        }
      })();
    };
    const onAbort = () => terminate("stopped");
    if (deps.signal?.aborted) { finish(null, "stopped", "R-ORC-13: external executor stopped."); return; }
    try {
      const launch = externalLaunch(executable, args, env);
      child = (deps.spawn ?? spawn)(launch.executable, launch.args, { cwd, env: launch.env, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      child.once("spawn", () => { void deps.onAccepted?.(); });
    } catch (error) { captureSpawnCode(error); finish(null, "failed", runFailureReason("R-ORC-13: external executor launch failed", error)); return; }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (data) => { output = (output + data.toString()).slice(0, maxOutput); });
    child.stderr?.on("data", () => {});
    child.once("error", (error) => { if (!terminating) { captureSpawnCode(error); finish(null, "failed", runFailureReason("R-ORC-13: external executor process failed", error)); } });
    child.once("exit", (code) => {
      if (terminating || settled) return;
      exited = true;
      clearTimeout(timer);
      if (!child.stdout || child.stdout.readableEnded) finish(code, "exited");
      else {
        child.stdout.once("end", () => finish(code, "exited"));
        drainTimer = setTimeout(() => finish(code, "exited"), 250);
      }
    });
    timer = setTimeout(() => terminate("timeout"), limit);
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    if (deps.signal?.aborted) onAbort();
  });
}

export async function listExternalModels(executor: ExternalRow["executor"], policy?: ApiKeyPolicy, deps: ExternalDependencies = {}): Promise<ExternalModelList> {
  try {
    const executable = (deps.resolve ?? resolveExternalExecutable)(executor);
    if (!executable) return { state: "failed", reason: "not-installed" };
    const env = buildClaudeEnv(process.env, policy).env;
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
  if (!path) return { state: "notInstalled" };
  return EXECUTORS[executor].detect!(executorProbe(path, buildClaudeEnv(process.env, policy).env, deps.timeoutMs ?? 10_000, deps));
}
async function captureModelRpc(executable: string, env: NodeJS.ProcessEnv, limit: number, deps: ExternalDependencies,
  args: string[], initialize: object, initialized: object, method: string, parse: Parameters<ExecutorProbe["rpc"]>[4]): Promise<ExternalModelList> {
    return await new Promise<ExternalModelList>((resolveList) => {
      let child: ChildProcess | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false, buffer = "", received = 0, requestId = 1, pages = 0;
      const models: ExternalModel[] = [];
      const finishList = (result: ExternalModelList) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void (async () => {
          try {
            if (child?.pid) await (deps.killTree ?? killExternalTree)(child.pid);
            resolveList(result);
          } catch (error) {
            let reason = runFailureReason("model-list-termination-failed", error);
            try { child?.kill?.(); }
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
          if (settled) return;
          buffer += chunk.toString();
          received += chunk.toString().length;
          if (received > 1_000_000) { failedList("model-list-too-large"); return; }
          try {
            let newline: number;
            while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (!line.trim()) continue;
              const response = JSON.parse(line);
              if (!response || typeof response !== "object") throw new Error("R-ORC-12: invalid response");
              if (response.id !== requestId) continue;
              if (response.error || !response.result) { failedList("model-list-rpc-failed"); return; }
              if (requestId === 1) {
                requestId = 2;
                sendList(initialized);
                sendList({ id: requestId, method, params: {} });
              } else {
                const page = parse(response.result);
                if (page.state === "failed") { finishList(page); return; }
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
  let accepted = false;
  let acceptance: Promise<void> = Promise.resolve();
  let attestation: CodexAttestation | undefined;
  let executable: string | undefined;
  if (deps.signal?.aborted) { parsed = { outcome: "stopped", answer: "R-ORC-13: external executor stopped." }; return completedRun(); }
  try {
    cwd = await resolveExternalCwd(options.cwd, input.cwd, deps.worktrees, deps.commonDir);
  } catch (error) {
    parsed = { outcome: "refused", answer: error instanceof Error && error.message.startsWith("R-ORC-35:")
      ? error.message : "R-ORC-35: registered git worktrees could not be read." };
    return completedRun();
  }
  if (deps.signal?.aborted) { parsed = { outcome: "stopped", answer: "R-ORC-13: external executor stopped." }; return completedRun(); }
  try {
    executable = (deps.resolve ?? resolveExternalExecutable)(row.executor);
    if (!executable) return { ...completedRun(), boundaryCode: "target_unavailable" as const };
    const base = externalPrompt(row.executor, input, row.role);
    const env = buildClaudeEnv(process.env, options.apiKeyPolicy).env;
    const commandLineUsage = (prompt: string) => {
      const launch = externalLaunch(executable!, externalArgv(row, cwd!, options.timeoutMinutes, prompt), env);
      return windowsCommandLineUnits(launch.executable, launch.args);
    };
    const budget: PromptBudget = { adapter: `${row.executor}-createprocess-utf16-v1`, learningAdditionCap: LEARNING_ADDITION_CODE_POINT_CAP,
      commandLineLimit: WINDOWS_COMMAND_LINE_UTF16_LIMIT, commandLineUsage };
    if (commandLineUsage(base) > budget.commandLineLimit!) throw new Error(DISPATCH_BUDGET_EXCEEDED);
    const prompt = deps.preparePrompt?.(base, JSON.stringify(externalArgv(row, cwd, options.timeoutMinutes, "")), budget) ?? base;
    if (commandLineUsage(prompt) > budget.commandLineLimit!) throw new Error(DISPATCH_BUDGET_EXCEEDED);
    args = externalArgv(row, cwd, options.timeoutMinutes, prompt);
  } catch (error) {
    parsed = { outcome: "failed", answer: error instanceof Error && error.message.startsWith("R-LRN-35:")
      ? DISPATCH_BUDGET_EXCEEDED : error instanceof Error && [
        "R-ORC-12: files must be absolute paths", "R-ORC-12: invalid executor settings", "R-ORC-12: unsupported executable shim",
      ].includes(error.message) ? error.message : runFailureReason("R-ORC-12: invalid external executor input or settings.", error) };
    return completedRun();
  }
  if (deps.signal?.aborted) { parsed = { outcome: "stopped", answer: "R-ORC-13: external executor stopped." }; return completedRun(); }
  try {
    if (executable) {
      const result = await capture(executable, args, cwd, buildClaudeEnv(process.env, options.apiKeyPolicy).env,
        deps.timeoutMs ?? options.timeoutMinutes * 60_000, { ...deps, onAccepted: () => {
          accepted = true;
          acceptance = Promise.resolve(deps.onAccepted?.());
          void acceptance.catch(() => undefined);
          return acceptance;
        } });
      await acceptance;
      if (row.executor === "codex") attestation = await observeCodexSession(result.output, started, Date.now(), deps.codexHome);
      parsed = result.status === "timeout" ? { outcome: "timeout", answer: result.reason ?? "External executor timed out." }
        : result.status === "stopped" ? { outcome: "stopped", answer: result.reason ?? "External executor stopped." }
        : result.reason ? { outcome: "failed", answer: result.reason } : parseExternalOutput(row.executor, result.output, result.code);
    } else return { ...completedRun(), boundaryCode: "target_unavailable" as const };
  } catch (error) {
    parsed = { outcome: "failed", answer: runFailureReason("R-ORC-13: external executor failed.", error) };
  }
  return completedRun();
  function completedRun() {
    const ended = Date.now();
    const record: ExternalRunRecord = Object.freeze({ kind: "external", ...(cwd ? { cwd } : {}), role: row.role, executor: row.executor, ...(row.model ? { model: row.model } : {}),
      requestedModel: row.model || "unknown", requestedEffort: row.effort ?? "none", observedModel: attestation?.model ?? "unknown", observedEffort: attestation?.effort ?? "unknown",
      ...(attestation ? { attestation } : {}),
      ...(row.effort === undefined ? {} : { effort: row.effort }), startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: ended - started,
      outcome: parsed.outcome, reason: parsed.outcome === "ok" ? undefined : parsed.answer, usage: parsed.usage });
    return { record, accepted, result: { isError: parsed.outcome !== "ok", content: [{ type: "text" as const, text: parsed.answer }] } };
  }
}
