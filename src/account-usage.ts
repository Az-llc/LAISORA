import type { Options as ClaudeCodeOptions } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type * as ClaudeCodeSdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

import { buildClaudeEnv } from "./claude-env";
import {
  ACCOUNT_USAGE_REUSE_MS,
  ACCOUNT_USAGE_ROWS_MAX,
  ACCOUNT_USAGE_TIMEOUT_MS,
  isCurrentAccountUsageRow,
  type AccountUsageRow,
  type AccountUsageSnapshot,
  type ApiKeyPolicy,
} from "./protocol";

const DOCUMENTED_WINDOWS: ReadonlyArray<readonly [string, string, string | undefined]> = [
  ["five_hour", "session", undefined],
  ["seven_day", "weekly_all", undefined],
  ["seven_day_opus", "weekly_scoped", "Opus"],
  ["seven_day_sonnet", "weekly_scoped", "Sonnet"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResetsAt(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function serverRow(value: unknown): AccountUsageRow | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, percent, severity, scope } = value;
  if (typeof kind !== "string" || kind.length === 0 || typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  const resetsAt = parseResetsAt(value.resets_at);
  if (resetsAt === undefined) return undefined;
  const scopeRecord = isRecord(scope) ? scope : undefined;
  const scopeName = [scopeRecord?.model, scopeRecord?.surface]
    .map((part) => (isRecord(part) && typeof part.display_name === "string" ? part.display_name : undefined))
    .find((name) => name !== undefined && name.length > 0);
  return {
    kind: clip(kind, 100),
    percent,
    resetsAt,
    ...(scopeName !== undefined ? { scope: clip(scopeName, 100) } : {}),
    ...(typeof severity === "string" && severity.length > 0 ? { severity: clip(severity, 50) } : {}),
  };
}

function windowRow(kind: string, value: unknown, scope: string | undefined): AccountUsageRow | undefined {
  if (!isRecord(value) || typeof value.utilization !== "number" || !Number.isFinite(value.utilization)) return undefined;
  const resetsAt = parseResetsAt(value.resets_at);
  if (resetsAt === undefined) return undefined;
  return { kind, percent: value.utilization, resetsAt, ...(scope !== undefined ? { scope: clip(scope, 100) } : {}) };
}

export function accountUsageRows(rateLimits: unknown, nowMs: number): AccountUsageRow[] | null {
  if (!isRecord(rateLimits)) return null;
  let rows: AccountUsageRow[];
  if (Array.isArray(rateLimits.limits)) {
    rows = rateLimits.limits.map(serverRow).filter((row): row is AccountUsageRow => row !== undefined);
  } else {
    rows = DOCUMENTED_WINDOWS
      .map(([key, kind, scope]) => windowRow(kind, rateLimits[key], scope))
      .filter((row): row is AccountUsageRow => row !== undefined);
    if (Array.isArray(rateLimits.model_scoped)) {
      for (const entry of rateLimits.model_scoped) {
        const name = isRecord(entry) && typeof entry.display_name === "string" ? entry.display_name : undefined;
        const row = windowRow("weekly_scoped", entry, name);
        if (row) rows.push(row);
      }
    }
  }
  return rows.filter((row) => isCurrentAccountUsageRow(row, nowMs)).slice(0, ACCOUNT_USAGE_ROWS_MAX);
}

export interface UsageCommandOptions {
  cwd: string;
  apiKeyPolicy: ApiKeyPolicy;
  resolveExecutablePath: () => Promise<string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  loadSdk?: () => Pick<typeof ClaudeCodeSdk, "query">;
}

function defaultLoadSdk(): Pick<typeof ClaudeCodeSdk, "query"> {
  return require("@anthropic-ai/claude-agent-sdk") as typeof ClaudeCodeSdk;
}

export function usageErrorTag(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? `${error.name}:${code}` : error.name;
}

export async function rateLimitsViaUsageCommand(opts: UsageCommandOptions): Promise<unknown> {
  if (opts.signal?.aborted) throw new Error("usage command aborted");
  const sdk = (opts.loadSdk ?? defaultLoadSdk)();
  const pathToClaudeCodeExecutable = await opts.resolveExecutablePath();
  if (opts.signal?.aborted) throw new Error("usage command aborted");
  const abortController = new AbortController();
  const onAbort = (): void => abortController.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const options: ClaudeCodeOptions = {
    tools: [],
    allowedTools: [],
    permissionMode: "default",
    persistSession: false,
    settingSources: [],
    maxTurns: 1,
    cwd: opts.cwd,
    env: buildClaudeEnv(process.env, opts.apiKeyPolicy).env,
    abortController,
  };
  if (pathToClaudeCodeExecutable !== undefined) options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
  const timer = setTimeout(() => abortController.abort(), opts.timeoutMs ?? ACCOUNT_USAGE_TIMEOUT_MS);
  const stream = sdk.query({ prompt: "/usage", options });
  try {
    for await (const message of stream) {
      if (abortController.signal.aborted) break;
      if (message.type !== "assistant") continue;
      const report = (message as { usage_report?: unknown }).usage_report;
      if (isRecord(report)) return report.rate_limits ?? null;
    }
    if (abortController.signal.aborted) throw new Error("usage command aborted");
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    stream.close();
  }
}

export interface AccountUsageSources {
  identity: string;
  viaConversation?: (signal: AbortSignal) => Promise<unknown>;
  viaUsageCommand: (signal: AbortSignal) => Promise<unknown>;
}

interface AccountUsageRun {
  identity: string;
  abort: AbortController;
  waiters: Set<unknown>;
  promise: Promise<AccountUsageSnapshot | undefined>;
}

export class AccountUsageFetcher {
  private seq = 0;
  private last: { identity: string; snapshot: AccountUsageSnapshot } | undefined;
  private inFlight: AccountUsageRun | undefined;
  private disposed = false;

  constructor(
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  request(waiter: unknown, sources: AccountUsageSources): Promise<AccountUsageSnapshot | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    const reusable = this.reusable(sources.identity);
    if (reusable) return Promise.resolve(reusable);
    const current = this.inFlight;
    if (current && current.identity === sources.identity) {
      current.waiters.add(waiter);
      return current.promise;
    }
    if (current) this.cancel(current);
    const abort = new AbortController();
    const seq = ++this.seq;
    const run: AccountUsageRun = {
      identity: sources.identity,
      abort,
      waiters: new Set([waiter]),
      promise: Promise.resolve(undefined),
    };
    run.promise = this.fetch(seq, sources, abort.signal).then(({ snapshot, cacheable }) => {
      if (this.inFlight === run) this.inFlight = undefined;
      if (this.disposed || abort.signal.aborted) return undefined;
      if (cacheable && (!this.last || this.last.snapshot.seq < snapshot.seq)) {
        this.last = { identity: sources.identity, snapshot };
      }
      return snapshot;
    });
    this.inFlight = run;
    return run.promise;
  }

  release(waiter: unknown): void {
    const current = this.inFlight;
    if (!current || !current.waiters.delete(waiter)) return;
    if (current.waiters.size === 0) this.cancel(current);
  }

  dispose(): void {
    this.disposed = true;
    this.last = undefined;
    if (this.inFlight) this.cancel(this.inFlight);
  }

  private cancel(run: AccountUsageRun): void {
    run.abort.abort();
    if (this.inFlight === run) this.inFlight = undefined;
  }

  private reusable(identity: string): AccountUsageSnapshot | undefined {
    const last = this.last;
    if (!last || last.identity !== identity) return undefined;
    const now = this.now();
    if (now - last.snapshot.fetchedAtMs >= ACCOUNT_USAGE_REUSE_MS) return undefined;
    const rows = last.snapshot.rows.filter((row) => isCurrentAccountUsageRow(row, now));
    if (last.snapshot.rows.length > 0 && rows.length === 0) return undefined;
    return { ...last.snapshot, rows };
  }

  private async fetch(seq: number, sources: AccountUsageSources, signal: AbortSignal): Promise<{ snapshot: AccountUsageSnapshot; cacheable: boolean }> {
    const failures: string[] = [];
    let rows: AccountUsageRow[] | null = null;
    if (sources.viaConversation) {
      try {
        rows = accountUsageRows(await sources.viaConversation(signal), Number.NEGATIVE_INFINITY);
      } catch (error) {
        failures.push(`conversation: ${usageErrorTag(error)}`);
      }
    }
    let commandFailed = false;
    if (rows === null && !signal.aborted && !this.disposed) {
      try {
        rows = accountUsageRows(await sources.viaUsageCommand(signal), Number.NEGATIVE_INFINITY);
      } catch (error) {
        commandFailed = true;
        failures.push(`/usage: ${usageErrorTag(error)}`);
      }
    }
    if (failures.length > 0) this.log(`[usage] fetch failed (${failures.join(" / ")})`);
    const fetchedAtMs = this.now();
    if (rows !== null) {
      const current = rows.filter((row) => isCurrentAccountUsageRow(row, fetchedAtMs));
      return { snapshot: { seq, fetchedAtMs, state: "ok", rows: current }, cacheable: rows.length === 0 || current.length > 0 };
    }
    return { snapshot: { seq, fetchedAtMs, state: commandFailed ? "failed" : "unavailable", rows: [] }, cacheable: false };
  }
}
