import { pathIsInside, lexicalPathIsInsideForEarlyRejectOnly, realPathOrNearestSync } from "./path-containment";
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, lstat, readlink, rm, stat, realpath, utimes, writeFile } from "node:fs/promises";
import { EXTERNAL_RUN_MARKER_HEARTBEAT_MS, externalRunMarkerFresh } from "./cli-update-policy";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildClaudeEnv, claudeConfigDir, envValueOf } from "./claude-env";
import { gitInertEnv, isControlPath } from "./placement-guard";
import { EXTERNAL_CAPABILITIES, externalExecutorName, isExternalRows, isExternalTimeout, type ExternalRow, type ExternalDetection, type ExternalModel, type ExternalModelList } from "./orchestration-roster";
import type { ApiKeyPolicy } from "./protocol";

export { isExternalRows, isExternalTimeout } from "./orchestration-roster";
export type { ExternalRow } from "./orchestration-roster";
import { EXECUTORS, EXTERNAL_EXECUTORS, isExternalExecutorId, isExternalModel, isExternalRunOutcome, tokenUsage, type ExternalRunOutcome, type TokenUsage, type ExecutorProbe } from "./orchestration-executors";
export { tokenUsage, parseAgyModels, parseCodexModels } from "./orchestration-executors";
export type { TokenUsage } from "./orchestration-executors";
export const WINDOWS_COMMAND_LINE_UTF16_LIMIT = 32767;
export const EXTERNAL_COMMAND_LINE_EXCEEDED = "R-ORC-12: task prompt exceeds the executor command-line limit";
export interface ExternalRunRecord {
  readonly kind: "external";
  readonly toolUseId?: string;
  readonly cwd?: string;
  readonly role: string;
  readonly executor: ExternalRow["executor"];
  readonly model?: string;
  readonly effort?: ExternalRow["effort"];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly outcome: ExternalRunOutcome;
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
export function attestedExternalRun(run: { readonly attestation?: CodexAttestation; readonly observedModel?: unknown; readonly observedEffort?: unknown }): CodexAttestation | undefined {
  const attestation = run.attestation;
  return attestation !== undefined && attestation.source === "codex-turn-context" && attestation.model === run.observedModel
    && attestation.effort === run.observedEffort ? attestation : undefined;
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

const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function decodeExternalRunRecord(raw: unknown): ExternalRunRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "external" || typeof r.role !== "string" || !/^[a-z][a-z0-9-]*$/.test(r.role) || !isExternalExecutorId(r.executor)) return undefined;
  if (!timestamp(r.startedAt) || !timestamp(r.endedAt) || typeof r.durationMs !== "number" || !Number.isFinite(r.durationMs) || r.durationMs < 0) return undefined;
  if (!isExternalRunOutcome(r.outcome)) return undefined;
  if (r.model !== undefined && (!isExternalModel(r.model) || r.model === "")) return undefined;
  if (r.effort !== undefined && (typeof r.effort !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.effort))) return undefined;
  if ((r.cwd !== undefined && typeof r.cwd !== "string") || (r.reason !== undefined && typeof r.reason !== "string")) return undefined;
  if ((r.runId !== undefined && typeof r.runId !== "string") || (r.sessionId !== undefined && typeof r.sessionId !== "string")) return undefined;
  const usage = tokenUsage(r.usage);
  for (const field of ["toolUseId", "conversation", "recipient", "dispatchId", "requestedModel", "requestedEffort", "observedModel", "observedEffort"]) {
    if (r[field] !== undefined && (typeof r[field] !== "string" || !/^[A-Za-z0-9._:\[\]-]+$/.test(String(r[field])))) return undefined;
  }
  const attested = attestedExternalRun({ attestation: r.executor === "codex" ? decodeCodexAttestation(r.attestation) : undefined,
    observedModel: r.observedModel, observedEffort: r.observedEffort });
  return Object.freeze({ kind: "external", ...(r.cwd !== undefined ? { cwd: r.cwd } : {}), role: r.role, executor: r.executor,
    ...(r.model !== undefined ? { model: r.model } : {}), ...(r.effort !== undefined ? { effort: r.effort as ExternalRunRecord["effort"] } : {}),
    startedAt: r.startedAt, endedAt: r.endedAt, durationMs: r.durationMs, outcome: r.outcome as ExternalRunRecord["outcome"],
    ...(r.reason !== undefined ? { reason: r.reason } : {}), ...(usage ? { usage } : {}),
    ...(r.toolUseId !== undefined ? { toolUseId: r.toolUseId as string } : {}),
    ...(r.runId !== undefined ? { runId: r.runId } : {}), ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.conversation !== undefined ? { conversation: r.conversation as string } : {}),
    ...(r.recipient !== undefined ? { recipient: r.recipient as string } : {}), ...(r.dispatchId !== undefined ? { dispatchId: r.dispatchId as string } : {}),
    requestedModel: (r.requestedModel ?? r.model ?? "unknown") as string,
    requestedEffort: (r.requestedEffort ?? r.effort ?? "unknown") as string,
    observedModel: attested ? attested.model : "unknown", observedEffort: attested ? attested.effort : "unknown",
    ...(attested ? { attestation: attested } : {}) });
}

export interface SessionExternalRuns {
  runs: ExternalRunRecord[];
  unreadableLines: number;
  readError: boolean;
}

export function decodeAgentRunRecord(raw: unknown): AgentRunRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "agent" || typeof r.agent_id !== "string" || !r.agent_id
    || !timestamp(r.firstSeenAt) || !timestamp(r.lastActivityAt) || r.firstSeenAt > r.lastActivityAt
    || r.outcome !== undefined && !["normal", "stopped", "timeout", "unknown"].includes(String(r.outcome))
    || r.confirmedAt !== undefined && !timestamp(r.confirmedAt)
    || r.segment !== undefined && (!Number.isSafeInteger(r.segment) || Number(r.segment) < 0)
    || r.outcomeEvidence !== undefined && (!Array.isArray(r.outcomeEvidence) || !r.outcomeEvidence.every(value => typeof value === "string"))) return undefined;
  for (const field of ["runId", "sessionId", "conversation", "recipient", "dispatchId", "agentKey", "role", "requestedModel", "requestedEffort", "model", "effort", "reason"]) {
    if (r[field] !== undefined && typeof r[field] !== "string") return undefined;
  }
  for (const field of ["role", "requestedModel", "requestedEffort", "model", "effort"]) {
    if (r[field] !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r[field] as string)) return undefined;
  }
  return Object.freeze({ ...r, usage: tokenUsage(r.usage) }) as unknown as AgentRunRecord;
}

export async function readRunRecords(directory: string, select: (raw: Record<string, unknown>) => boolean = () => true,
  countsUnreadable: (raw: Record<string, unknown>) => boolean = select) {
  let text: string;
  try { text = await readFile(join(directory, "runs.jsonl"), "utf8"); }
  catch (error) { return { runs: [] as OrchestrationRunRecord[], unreadableLines: 0, readError: (error as NodeJS.ErrnoException).code !== "ENOENT" }; }
  const runs: OrchestrationRunRecord[] = [];
  let unreadableLines = 0;
  for (const line of text.split("\n").slice(0, -1)) {
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { unreadableLines++; continue; }
    if (!raw || typeof raw !== "object" || !select(raw as Record<string, unknown>)) continue;
    const run = decodeExternalRunRecord(raw) ?? decodeAgentRunRecord(raw);
    if (run) runs.push(run); else if (countsUnreadable(raw as Record<string, unknown>)) unreadableLines++;
  }
  return { runs, unreadableLines, readError: false };
}

export async function readSessionExternalRuns(directory: string, sessionId: string): Promise<SessionExternalRuns> {
  return (await readExternalRunsForSession(directory, sessionId)).session;
}

export async function readExternalRunsForSession(directory: string, sessionId: string):
  Promise<{ session: SessionExternalRuns; byToolUseId: ReadonlyMap<string, ExternalRunRecord> }> {
  const ofSession = (raw: Record<string, unknown>) => raw.sessionId === sessionId && raw.kind !== "agent";
  const result = await readRunRecords(directory, raw => ofSession(raw) || raw.kind === "external" && typeof raw.toolUseId === "string", ofSession);
  const external = result.runs.filter((run): run is ExternalRunRecord => run.kind === "external");
  return {
    session: { ...result, runs: external.filter(run => run.sessionId === sessionId) },
    byToolUseId: new Map(external.flatMap(run => run.toolUseId !== undefined ? [[run.toolUseId, run] as const] : [])),
  };
}

export function resolveExternalExecutable(executor: ExternalRow["executor"], env = process.env, platform = process.platform): string | undefined {
  const get = (key: string) => envValueOf(env, key, platform);
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
          finish(null, status, status === "timeout" ? "R-ORC-11: external executor timed out." : EXTERNAL_STOPPED);
        } catch (error) {
          finish(null, status === "timeout" ? "timeout" : "failed", runFailureReason(
            status === "timeout" ? "R-ORC-11: external executor timed out; process tree termination failed" : "R-ORC-13: external executor stop failed; process tree termination failed", error));
        }
      })();
    };
    const onAbort = () => terminate("stopped");
    if (deps.signal?.aborted) { finish(null, "stopped", EXTERNAL_STOPPED); return; }
    try {
      const launch = externalLaunch(executable, args, env);
      child = (deps.spawn ?? spawn)(launch.executable, launch.args, { cwd, env: launch.env, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
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
        const fields = stdout.split("\0");
        const main = fields.slice(0, fields.indexOf(""));
        resolveList(error || main.includes("bare") ? [] : fields.filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9)));
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

async function worktreeSetting(common: string, file: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile("git", ["config", "--file", join(common, file), "--path", "--get", "core.worktree"],
      { cwd: common, shell: false, windowsHide: true, encoding: "utf8", timeout: 5000 }, (error, stdout) => {
        const worktree = stdout.trim();
        done(error || !worktree ? undefined : resolve(common, worktree));
      });
  });
}

async function configuredWorktree(common: string): Promise<string | undefined> {
  return await worktreeSetting(common, "config.worktree") ?? await worktreeSetting(common, "config");
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
  let existing: string = candidate;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const registeredWorktreePaths = common ? await worktrees(existing) : [];
  let main = registeredWorktreePaths[0] ? realPathOrNearestSync(registeredWorktreePaths[0]) : undefined;
  if (common && main === realPathOrNearestSync(common)) {
    const configured = await configuredWorktree(common);
    main = configured ? realPathOrNearestSync(configured) : undefined;
  }
  if (main && pathIsInside(root, main)) {
    for (const registered of registeredWorktreePaths) {
      const real = realPathOrNearestSync(registered);
      if (real && pathIsInside(real, candidate)) return candidate;
    }
  }
  throw new Error("R-ORC-35: cwd is outside the conversation directory, its registered git worktrees, and worktrees of repositories inside it.");
}

async function controlGit(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((done, reject) => {
    execFile("git", args, { cwd, env: gitInertEnv(), shell: false, windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) done(stdout);
        else if (error.code === 128 && /not a git repository/i.test(stderr)) done(undefined);
        else reject(error);
      });
  });
}

const CONTROL_NAMES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];
const CONTROL_SKIP = new Set(["node_modules", ".git", "dist"]);
const CONTROL_STAGED_ENTRY = /^(\d{6}) [0-9a-f]+ \d\t([\s\S]+)$/;
const CONTROL_GIT_LINK_MODE = "120000";
const CONTROL_UNTRACKED_PROBE_CAP = 2_000;
const CONTROL_WALK_CAP = 20_000;
const CONTROL_FILE_BYTE_LIMIT = 8 * 1024 * 1024;
const CONTROL_TIMEOUT_MS = 3000;
const controlKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;

type ControlType = "file" | "directory" | "other" | "missing";
interface ControlIdentity { linked: boolean; canonical?: string; exists?: boolean; link?: string; directory?: boolean; type?: ControlType }
interface ControlBudget { remaining: number; incomplete: boolean; deadline?: number; expired?: boolean }
function controlExpired(budget: ControlBudget): boolean {
  if (budget.expired || budget.deadline !== undefined && performance.now() >= budget.deadline) { budget.incomplete = true; return true; }
  return false;
}
async function controlAwait<T>(probe: () => Promise<T>, budget: ControlBudget, late?: (value: T) => void): Promise<T> {
  if (controlExpired(budget)) throw new Error("Control file deadline exceeded.");
  const pending = probe();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending.then(value => { if (expired) late?.(value); return value; }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; budget.expired = true; budget.incomplete = true; reject(new Error("Control file deadline exceeded.")); },
        Math.max(0, (budget.deadline ?? performance.now() + CONTROL_TIMEOUT_MS) - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}
function controlBudget(budget: ControlBudget, cost = 1): boolean {
  if (controlExpired(budget) || budget.remaining < cost) { budget.incomplete = true; return false; }
  budget.remaining -= cost;
  return true;
}
async function controlIdentity(path: string, cache: Map<string, ControlIdentity>, budget: ControlBudget): Promise<ControlIdentity> {
  const known = cache.get(path);
  if (known) return known;
  if (!controlBudget(budget, 4)) return { linked: false };
  let identity: ControlIdentity;
  try {
    const entry = await controlAwait(() => lstat(path), budget);
    const ownLink = entry?.isSymbolicLink() ?? false;
    let status: typeof entry | undefined = entry, canonical: string | undefined;
    if (entry) {
      try { canonical = controlKey(await controlAwait(() => realpath(path), budget)); }
      catch (error) { if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    if (ownLink) {
      try { status = await controlAwait(() => stat(path), budget); }
      catch (error) { if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; status = undefined; }
    }
    const type = !status ? "missing" : status.isFile() ? "file" : status.isDirectory() ? "directory" : "other";
    const linked = ownLink || !!canonical && canonical !== controlKey(resolve(path));
    const link = linked ? JSON.stringify([canonical ?? (ownLink ? await controlAwait(() => readlink(path), budget) : undefined), type]) : undefined;
    identity = { linked, link, canonical, exists: !!status, directory: type === "directory", type };
  } catch (error) {
    identity = ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
      ? { linked: false, exists: false, type: "missing" } : { linked: false };
  }
  cache.set(path, identity);
  return identity;
}

async function controlFiles(cwd: string, configDir: string, tree: string | undefined, budget: ControlBudget, linkCache: Map<string, ControlIdentity>) {
  const files = new Set<string>();
  if (!controlBudget(budget, 0)) return { files, incomplete: true };
  const directories = new Set([cwd, ...(tree ? [tree] : [])]);
  const linkedDirectories = new Set<string>();
  const untracked: string[] = [];
  let incomplete = false, visited = 0;
  const classify = (path: string) => isControlPath(path, configDir);
  const add = (path: string) => { if (classify(path) && controlBudget(budget)) files.add(path); };
  if (tree) {
    const listings = await controlAwait(() => Promise.all([
      controlGit(["ls-files", "-co", "-s", "--exclude-standard", "-z"], tree),
      controlGit(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--",
        ...[...CONTROL_NAMES, ".claude/**"].map(name => (process.platform === "win32" ? ":(glob,icase)**/" : ":(glob)**/") + name)], tree),
    ]), budget);
    for (const [listing, listed] of listings.entries()) {
      if (listed === undefined) throw new Error("Control file work tree is unavailable.");
      for (const entry of listed.split("\0").filter(Boolean)) {
        if (controlExpired(budget)) break;
        const staged = listing === 0 ? CONTROL_STAGED_ENTRY.exec(entry) : null;
        const file = staged ? staged[2] : entry;
        if (file.replace(/\\/g, "/").split("/").some(part => CONTROL_SKIP.has(process.platform === "win32" ? part.toLowerCase() : part))) continue;
        const path = resolve(tree, file);
        if (!classify(path)) {
          if (staged ? staged[1] !== CONTROL_GIT_LINK_MODE : listing !== 0) continue;
          if (!staged) { untracked.push(path); continue; }
          const identity = await controlIdentity(path, linkCache, budget);
          if (identity.linked && identity.directory) linkedDirectories.add(path);
          continue;
        }
        if (!controlBudget(budget)) break;
        files.add(path);
        const identity = await controlIdentity(path, linkCache, budget);
        if (identity.linked && identity.directory) linkedDirectories.add(path);
        let directory = dirname(path);
        while (lexicalPathIsInsideForEarlyRejectOnly(tree, directory)) {
          directories.add(directory);
          if (directory === tree || dirname(directory) === directory) break;
          directory = dirname(directory);
        }
      }
    }
  }
  const walked = new Set<string>();
  const walk = async (directory: string, ancestors = new Set<string>()): Promise<void> => {
    if (walked.has(directory)) return;
    walked.add(directory);
    if (++visited > CONTROL_WALK_CAP || !controlBudget(budget)) { incomplete = true; return; }
    const identity = await controlIdentity(directory, linkCache, budget);
    if (identity.linked && (classify(directory) || controlKey(directory).endsWith("/.claude") || controlKey(directory).endsWith("\\.claude"))) files.add(directory);
    if (identity.exists === false) return;
    if (classify(directory)) add(directory);
    if (!identity.directory) return;
    if (!identity.canonical || ancestors.has(identity.canonical)) { incomplete = true; return; }
    const nextAncestors = new Set([...ancestors, identity.canonical]);
    let entries;
    try { entries = await controlAwait(() => readdir(directory, { withFileTypes: true }), budget); }
    catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      incomplete = true; return;
    }
    for (const entry of entries) {
      if (++visited > CONTROL_WALK_CAP || !controlBudget(budget)) { incomplete = true; return; }
      if (CONTROL_SKIP.has(process.platform === "win32" ? entry.name.toLowerCase() : entry.name)) continue;
      const path = join(directory, entry.name);
      const child = entry.isSymbolicLink() ? await controlIdentity(path, linkCache, budget) : undefined;
      if (entry.isDirectory() || child?.directory) await walk(path, nextAncestors);
      else add(path);
    }
  };
  if (!tree) await walk(cwd);
  for (const directory of linkedDirectories) await walk(directory);
  for (const directory of directories) {
    if (!controlBudget(budget, CONTROL_NAMES.length + 2)) break;
    for (const name of CONTROL_NAMES) files.add(join(directory, name));
    for (const name of ["settings.json", "settings.local.json"]) files.add(join(directory, ".claude", name));
    await walk(join(directory, ".claude"));
  }
  files.add(join(configDir, "CLAUDE.md"));
  files.add(join(configDir, "settings.json"));
  await walk(join(configDir, "rules"));
  await walk(join(configDir, "hooks"));
  if (controlBudget(budget)) {
    try {
      for (const project of await controlAwait(() => readdir(join(configDir, "projects")), budget)) {
        if (!controlBudget(budget)) break;
        await walk(join(configDir, "projects", project, "memory"));
      }
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) incomplete = true;
    }
  }
  if (untracked.length > CONTROL_UNTRACKED_PROBE_CAP) incomplete = true;
  for (const path of untracked.slice(0, CONTROL_UNTRACKED_PROBE_CAP)) {
    if (controlExpired(budget)) break;
    try {
      if (!(await controlAwait(() => lstat(path), budget)).isSymbolicLink()) continue;
      const identity = await controlIdentity(path, linkCache, budget);
      if (identity.linked && identity.directory) await walk(path);
    } catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) incomplete = true; }
  }
  return { files, incomplete: incomplete || budget.incomplete };
}

interface ControlContent { kindChanged?: boolean; hash?: string; type?: ControlType; exists?: boolean; tooLarge?: boolean; size?: number; mtimeMs?: number }
async function controlHash(path: string, budget: ControlBudget): Promise<ControlContent> {
  if (!controlBudget(budget, 3)) return {};
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await controlAwait(() => open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)), budget,
      opened => { void opened.close().catch(() => undefined); });
    if (controlExpired(budget)) return {};
    const status = await controlAwait(() => handle!.stat(), budget);
    if (!status.isFile()) return { type: status.isDirectory() ? "directory" : "other", exists: true, kindChanged: true };
    const identity = { size: status.size, mtimeMs: status.mtimeMs };
    if (status.size > CONTROL_FILE_BYTE_LIMIT) return { ...identity, tooLarge: true };
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < status.size) {
      if (!controlBudget(budget)) return {};
      const { bytesRead } = await controlAwait(() => handle!.read(buffer, 0, Math.min(buffer.length, status.size - position), position), budget);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (!controlBudget(budget)) return {};
    const after = await controlAwait(() => handle!.stat(), budget);
    if (after.size > CONTROL_FILE_BYTE_LIMIT) return { size: after.size, mtimeMs: after.mtimeMs, tooLarge: true };
    if (after.size !== status.size || after.mtimeMs !== status.mtimeMs || position !== status.size) budget.incomplete = true;
    return { ...identity, hash: hash.digest("hex") };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return { type: "missing", exists: false };
    throw error;
  } finally {
    if (handle) {
      const closing = handle.close().catch(() => { budget.incomplete = true; });
      await controlAwait(() => closing, budget).catch(() => { budget.incomplete = true; });
    }
  }
}

async function controlStates(paths: Iterable<string>, cache: Map<string, ControlIdentity>, budget: ControlBudget) {
  const states = new Map<string, ControlIdentity & ControlContent>();
  const files = [...paths];
  for (let offset = 0; offset < files.length; offset += 8) {
    if (!controlBudget(budget, 0)) break;
    const batch = await Promise.all(files.slice(offset, offset + 8).map(async path => {
      const identity = await controlIdentity(path, cache, budget);
      let content: ControlContent = {};
      if (identity.type === "file") {
        try { content = await controlHash(path, budget); } catch { budget.incomplete = true; }
      }
      if (identity.exists === undefined && !identity.link) budget.incomplete = true;
      return [path, { ...identity, ...content }] as const;
    }));
    for (const [path, state] of batch) states.set(path, state);
  }
  return states;
}

async function snapshotControlFiles(cwd: string, configDir: string) {
  const budget: ControlBudget = { remaining: CONTROL_WALK_CAP, incomplete: false, deadline: performance.now() + CONTROL_TIMEOUT_MS };
  const cache = new Map<string, ControlIdentity>();
  let tree: string | undefined;
  let states: Awaited<ReturnType<typeof controlStates>> = new Map();
  try {
    tree = (await controlAwait(() => controlGit(["rev-parse", "--show-toplevel"], cwd), budget))?.replace(/\r?\n$/, "");
    const enumeration = await controlFiles(cwd, configDir, tree, budget, cache);
    states = await controlStates(enumeration.files, cache, budget);
    budget.incomplete ||= enumeration.incomplete;
  } catch { budget.incomplete = true; }
  return { cwd, configDir, tree, states, incomplete: budget.incomplete };
}

async function compareControlFiles(snapshot: Awaited<ReturnType<typeof snapshotControlFiles>>): Promise<string | undefined> {
  const changes: string[] = [];
  const budget: ControlBudget = { remaining: CONTROL_WALK_CAP, incomplete: false, deadline: performance.now() + CONTROL_TIMEOUT_MS };
  const cache = new Map<string, ControlIdentity>();
  const paths = new Set(snapshot.states.keys());
  let incomplete = snapshot.incomplete;
  const label = (path: string) => lexicalPathIsInsideForEarlyRejectOnly(snapshot.tree ?? snapshot.cwd, path) ? relative(snapshot.cwd, path).replace(/\\/g, "/") : path;
  try {
    const enumeration = await controlFiles(snapshot.cwd, snapshot.configDir, snapshot.tree, budget, cache);
    incomplete ||= enumeration.incomplete;
    for (const path of enumeration.files) paths.add(path);
  } catch { incomplete = true; }
  const states = await controlStates(paths, cache, budget);
  for (const [path, current] of states) {
    if (controlExpired(budget)) break;
    try {
      const before = snapshot.states.get(path);
      let kind: "modified" | "created" | "deleted" | "modified via link" | "link changed" | "kind changed" | undefined;
      if (current.exists === undefined || before && before.exists === undefined) { incomplete = true; continue; }
      if (before && (before.link !== current.link || before.linked !== current.linked
        || before.canonical && current.canonical && before.canonical !== current.canonical)
        || !before && !current.exists && current.link) kind = "link changed";
      else if (before?.exists && !current.exists) kind = "deleted";
      else if (current.kindChanged || before?.kindChanged || current.type === "other" || before?.exists && current.exists && before.type !== current.type) kind = "kind changed";
      else if (!before?.exists && current.exists) kind = "created";
      else if (current.type === "file" && (current.tooLarge || before?.tooLarge)) {
        if (current.size !== before?.size || current.mtimeMs !== before?.mtimeMs) kind = current.linked ? "modified via link" : "modified";
      }
      else if (current.type === "file") {
        const hash = current.hash;
        if (hash === undefined && budget.incomplete || before?.hash === undefined) incomplete = true;
        else if (hash !== before.hash) kind = hash === undefined ? "deleted" : current.linked ? "modified via link" : "modified";
      }
      if (current.tooLarge || before?.tooLarge) changes.push("- " + label(path) + " (too large to compare; size+mtime identity)");
      if (kind) changes.push("- " + label(path) + " (" + kind + ")");
    } catch { incomplete = true; }
  }
  incomplete ||= budget.incomplete;
  return changes.length || incomplete
    ? ["Control files changed during the run:", ...changes, ...(incomplete ? ["control-file snapshot incomplete."] : []),
      "Delegates may not change these files. The conductor must review and revert unwanted changes before committing."].join("\n")
    : undefined;
}

let activeExternalRuns = 0;
let externalRunMarkerDirectory: string | undefined;
let externalRunSerial = 0;
const RUN_MARKER_PREFIX = "run-";
const UPDATING_MARKER_PREFIX = "updating-";
const UPDATE_WAIT_POLL_MS = 500;
const externalExecutorUpdates = new Map<ExternalRow["executor"], Promise<void>>();

let externalRunMarkerLog: ((line: string) => void) | undefined;
const loggedMarkerFailures = new Set<string>();

export function setExternalRunMarkerDirectory(directory: string | undefined, log?: (line: string) => void): void {
  externalRunMarkerDirectory = directory;
  externalRunMarkerLog = log;
}

export function externalRunActive(): boolean {
  return activeExternalRuns > 0;
}

async function freshMarkers(prefix: string, now = Date.now()): Promise<string[]> {
  const directory = externalRunMarkerDirectory;
  if (!directory) return [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const fresh: string[] = [];
  for (const name of names.filter((entry) => entry.startsWith(prefix))) {
    const file = join(directory, name);
    const modified = await stat(file).then((entry) => entry.mtimeMs, () => undefined);
    if (externalRunMarkerFresh(now, modified)) fresh.push(name);
    else if (modified !== undefined) await rm(file, { force: true }).catch(() => undefined);
  }
  return fresh;
}

export async function externalRunActiveAnywhere(now = Date.now()): Promise<boolean> {
  return externalRunActive() || (await freshMarkers(RUN_MARKER_PREFIX, now)).length > 0;
}

async function executorUpdatingAnywhere(executor: ExternalRow["executor"]): Promise<boolean> {
  return externalExecutorUpdates.has(executor) || (await freshMarkers(`${UPDATING_MARKER_PREFIX}${executor}`)).length > 0;
}

async function startMarker(name: string): Promise<(() => Promise<void>) | undefined> {
  const directory = externalRunMarkerDirectory;
  if (!directory) return undefined;
  const file = join(directory, name);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(file, "");
  } catch (error) {
    const reason = runFailureReason("marker-write-failed", error);
    if (!loggedMarkerFailures.has(reason)) {
      loggedMarkerFailures.add(reason);
      externalRunMarkerLog?.(`[external-run] ${reason}; other windows cannot see this run or update`);
    }
    return undefined;
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(file, now, now).catch(() => undefined);
  }, EXTERNAL_RUN_MARKER_HEARTBEAT_MS);
  return async () => {
    clearInterval(heartbeat);
    await rm(file, { force: true }).catch(() => undefined);
  };
}

export function markExternalExecutorUpdating(executor: ExternalRow["executor"]): Promise<(() => Promise<void>) | undefined> {
  return startMarker(`${UPDATING_MARKER_PREFIX}${executor}-${process.pid}`);
}

export function holdExternalRunsDuring<T>(executor: ExternalRow["executor"], work: () => Promise<T>): Promise<T> {
  const result = work();
  const settled = result.then(() => undefined, () => undefined);
  externalExecutorUpdates.set(executor, settled);
  void settled.then(() => {
    if (externalExecutorUpdates.get(executor) === settled) externalExecutorUpdates.delete(executor);
  });
  return result;
}

export function remainingRunTimeoutMs(totalMs: number, waitedMs: number): number {
  return Math.max(1, totalMs - Math.max(0, waitedMs));
}

const EXTERNAL_STOPPED = "R-ORC-13: external executor stopped.";
export const EXTERNAL_UPDATE_WAIT_TIMEOUT = "R-ORC-13: external executor timed out while its CLI was being updated.";

function pause(update: Promise<void> | undefined, signal: AbortSignal | undefined, deadline: number): Promise<void> {
  return new Promise((resolveWait) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolveWait();
    };
    const timer = setTimeout(done, Math.max(0, Math.min(UPDATE_WAIT_POLL_MS, deadline - Date.now())));
    signal?.addEventListener("abort", done, { once: true });
    void update?.then(done);
  });
}

async function waitForExecutorUpdate(executor: ExternalRow["executor"], signal: AbortSignal | undefined, deadline: number): Promise<"ready" | "stopped" | "timeout"> {
  for (;;) {
    if (signal?.aborted) return "stopped";
    if (!await executorUpdatingAnywhere(executor)) return "ready";
    if (Date.now() >= deadline) return "timeout";
    await pause(externalExecutorUpdates.get(executor), signal, deadline);
  }
}

export async function runExternal(...args: Parameters<typeof runExternalUntracked>): ReturnType<typeof runExternalUntracked> {
  const [row, input, options, deps = {}] = args;
  const started = Date.now();
  const totalMs = deps.timeoutMs ?? options.timeoutMinutes * 60_000;
  const stopMarker = await startMarker(`${RUN_MARKER_PREFIX}${process.pid}-${++externalRunSerial}`);
  try {
    const waitResult = await waitForExecutorUpdate(row.executor, deps.signal, started + totalMs);
    if (waitResult === "stopped") return externalRunOutcome(row, started, { outcome: "stopped", answer: EXTERNAL_STOPPED }, {});
    if (waitResult === "timeout") return externalRunOutcome(row, started, { outcome: "timeout", answer: EXTERNAL_UPDATE_WAIT_TIMEOUT }, {});
    const waited = Date.now() - started;
    activeExternalRuns++;
    try {
      return await runExternalUntracked(row, input, options, { ...deps, timeoutMs: remainingRunTimeoutMs(totalMs, waited) });
    } finally {
      activeExternalRuns--;
    }
  } finally {
    await stopMarker?.();
  }
}

async function runExternalUntracked(row: ExternalRow, input: ExternalInput, options: { cwd: string; configDir?: string; timeoutMinutes: number; apiKeyPolicy?: ApiKeyPolicy }, deps: ExternalDependencies = {}) {
  const started = Date.now();
  let parsed: ReturnType<typeof parseExternalOutput> = { outcome: "failed", answer: "R-ORC-13: external executor not found." };
  let args: string[];
  let cwd: string | undefined;
  let attestation: CodexAttestation | undefined;
  let executable: string | undefined;
  let snapshot: Awaited<ReturnType<typeof snapshotControlFiles>> | undefined;
  let controlWarning: string | undefined;
  if (deps.signal?.aborted) { parsed = { outcome: "stopped", answer: EXTERNAL_STOPPED }; return completedRun(); }
  try {
    cwd = await resolveExternalCwd(options.cwd, input.cwd, deps.worktrees, deps.commonDir);
  } catch (error) {
    parsed = { outcome: "refused", answer: error instanceof Error && error.message.startsWith("R-ORC-35:")
      ? error.message : "R-ORC-35: registered git worktrees could not be read." };
    return completedRun();
  }
  if (deps.signal?.aborted) { parsed = { outcome: "stopped", answer: EXTERNAL_STOPPED }; return completedRun(); }
  try {
    executable = (deps.resolve ?? resolveExternalExecutable)(row.executor);
    if (!executable) return completedRun();
    const base = externalPrompt(row.executor, input, row.role);
    const env = buildClaudeEnv(process.env, options.apiKeyPolicy).env;
    const commandLineUsage = (prompt: string) => {
      const launch = externalLaunch(executable!, externalArgv(row, cwd!, options.timeoutMinutes, prompt), env);
      return windowsCommandLineUnits(launch.executable, launch.args);
    };
    if (commandLineUsage(base) > WINDOWS_COMMAND_LINE_UTF16_LIMIT) throw new Error(EXTERNAL_COMMAND_LINE_EXCEEDED);
    args = externalArgv(row, cwd, options.timeoutMinutes, base);
  } catch (error) {
    parsed = { outcome: "failed", answer: error instanceof Error && [
        EXTERNAL_COMMAND_LINE_EXCEEDED, "R-ORC-12: files must be absolute paths", "R-ORC-12: invalid executor settings", "R-ORC-12: unsupported executable shim",
      ].includes(error.message) ? error.message : runFailureReason("R-ORC-12: invalid external executor input or settings.", error) };
    return completedRun();
  }
  if (deps.signal?.aborted) { parsed = { outcome: "stopped", answer: EXTERNAL_STOPPED }; return completedRun(); }
  try {
    if (executable) {
      snapshot = await snapshotControlFiles(cwd, resolve(options.configDir ?? claudeConfigDir()));
      const result = await capture(executable, args, cwd, buildClaudeEnv(process.env, options.apiKeyPolicy).env,
        deps.timeoutMs ?? options.timeoutMinutes * 60_000, deps);
      if (row.executor === "codex") attestation = await observeCodexSession(result.output, started, Date.now(), deps.codexHome);
      parsed = result.status === "timeout" ? { outcome: "timeout", answer: result.reason ?? "External executor timed out." }
        : result.status === "stopped" ? { outcome: "stopped", answer: result.reason ?? "External executor stopped." }
        : result.reason ? { outcome: "failed", answer: result.reason } : parseExternalOutput(row.executor, result.output, result.code);
    } else return completedRun();
  } catch (error) {
    parsed = { outcome: "failed", answer: runFailureReason("R-ORC-13: external executor failed.", error) };
  } finally {
    if (snapshot) {
      controlWarning = await compareControlFiles(snapshot).catch(() => "control-file snapshot incomplete.");
    }
  }
  return completedRun();
  function completedRun() {
    return externalRunOutcome(row, started, parsed, { cwd, attestation, controlWarning });
  }
}

function externalRunOutcome(row: ExternalRow, started: number, parsed: ReturnType<typeof parseExternalOutput>,
  extra: { cwd?: string; attestation?: CodexAttestation; controlWarning?: string }) {
  const { cwd, attestation, controlWarning } = extra;
  const ended = Date.now();
  const record: ExternalRunRecord = Object.freeze({ kind: "external", ...(cwd ? { cwd } : {}), role: row.role, executor: row.executor, ...(row.model ? { model: row.model } : {}),
    requestedModel: row.model || "unknown", requestedEffort: row.effort ?? "none", observedModel: attestation?.model ?? "unknown", observedEffort: attestation?.effort ?? "unknown",
    ...(attestation ? { attestation } : {}),
    ...(row.effort === undefined ? {} : { effort: row.effort }), startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: ended - started,
    outcome: parsed.outcome, reason: parsed.outcome === "ok" ? undefined : parsed.answer, usage: parsed.usage });
  return { record, result: { isError: parsed.outcome !== "ok", content: [{ type: "text" as const, text: parsed.answer + (controlWarning ? `\n${controlWarning}` : "") }] } };
}
