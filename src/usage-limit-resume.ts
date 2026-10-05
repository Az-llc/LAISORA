import type { NormalizedEventBody } from "./protocol";

const USAGE_LIMIT_RESET_NOTICE = "Your claude.ai usage limit has reset.";
export const USAGE_LIMIT_CONTINUATION = `${USAGE_LIMIT_RESET_NOTICE} Continue the task you were working on when the limit was reached; do not repeat work that is already complete.`;
export const SDK_AUTO_CONTINUE_SETTINGS = { autoContinueAtUsageLimit: false } as const;
const LIVENESS_TICK_MS = 60_000;
const MAX_AUTOMATIC_ATTEMPTS = 3;

export function delegateResumeInstruction(agentIds: readonly string[]): string {
  return `These delegated agents stopped at the usage limit and have not been resumed: ${agentIds.join(", ")}. Resume each one with SendMessage to its agent ID so it continues where it stopped; do not launch new agents for the same work.`;
}

export function usageLimitResumeText(main: boolean, agentIds: readonly string[]): string {
  if (agentIds.length === 0) return USAGE_LIMIT_CONTINUATION;
  return `${main ? USAGE_LIMIT_CONTINUATION : USAGE_LIMIT_RESET_NOTICE} ${delegateResumeInstruction(agentIds)}`;
}

type ResumeNotice = Extract<NormalizedEventBody, { kind: "auto_resume" }>;
type RateLimitNotice = Extract<NormalizedEventBody, { kind: "rate_limit" }>;
interface ResumeRuntime {
  now(): number;
  random(): number;
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
  enabled(): boolean;
  connected(): boolean;
  live(): boolean;
  send(text: string): void;
  notify(event: ResumeNotice): void;
}

export class UsageLimitResume {
  private latestRateLimit?: RateLimitNotice;
  private subscription = false;
  private timer: unknown;
  private pendingAt: number | undefined;
  private pendingMain = false;
  private readonly stoppedDelegates = new Set<string>();
  private readonly observedDelegateStops = new Set<string>();
  private attempts = 0;
  private automaticTurn = false;
  private suppressed = false;
  private endedTurn: string | undefined;

  constructor(private readonly runtime: ResumeRuntime) {}

  get pendingResumeAt(): number | null { return this.pendingAt ?? null; }

  cancel(): void {
    this.suppressed = true;
    this.stoppedDelegates.clear();
    this.clearReservation();
  }

  manualSend(): void {
    this.cancel();
    this.suppressed = false;
    this.automaticTurn = false;
    this.latestRateLimit = undefined;
  }

  delegateStopped(agentId: string): void {
    if (this.observedDelegateStops.has(agentId)) return;
    this.observedDelegateStops.add(agentId);
    if (this.suppressed) return;
    this.stoppedDelegates.add(agentId);
    if (this.pendingAt === undefined) this.reserveForDelegates();
  }

  observe(event: NormalizedEventBody): void {
    if (event.kind === "auth_status") this.subscription = event.auth.billingRealm === "subscription";
    if (event.kind === "rate_limit") {
      this.latestRateLimit = event;
      if (this.stoppedDelegates.size > 0) this.reserveForDelegates();
    }
    if (event.kind === "tool_call_finished") {
      if (!event.isError && event.resumedAgentId !== undefined) {
        this.observedDelegateStops.delete(event.resumedAgentId);
        this.forgetDelegate(event.resumedAgentId);
      }
      if (event.taskNotification?.status === "completed" || event.taskNotification?.status === "stopped") {
        this.forgetDelegate(event.taskNotification.agentId);
      }
    }
    if (event.kind === "conversation_closed" || event.kind === "turn_interrupted") this.cancel();
    if (event.kind === "turn_started") {
      this.endedTurn = undefined;
      if (this.pendingAt !== undefined) this.dropMain();
    }
    if (event.kind === "turn_completed") {
      this.dropMain();
      this.attempts = 0;
      this.automaticTurn = false;
    }
    if (event.kind !== "turn_failed" || this.endedTurn === event.turnId) return;
    this.endedTurn = event.turnId;
    if (event.errorKind !== "usage_limit" || this.suppressed || (this.pendingAt !== undefined && this.pendingMain)) return;
    if (this.exhausted()) return;
    const rate = this.latestRateLimit;
    if (!this.runtime.live()) return;
    const at = this.reservationTime(rate, rate?.resetsAt ?? event.resetsAt);
    if (at === undefined) return;
    this.pendingMain = true;
    this.reserve(at);
  }

  private reservationTime(rate: RateLimitNotice | undefined, resetsAt: number | null | undefined): number | undefined {
    if (!this.runtime.enabled() || !this.subscription || rate?.status !== "rejected"
      || rate.isUsingOverage || rate.overageInUse === true || typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return undefined;
    const at = resetsAt + 60_000 + Math.floor(this.runtime.random() * 60_001);
    return at - this.runtime.now() > 86_400_000 ? undefined : at;
  }

  private exhausted(): boolean {
    if (!this.automaticTurn || this.attempts < MAX_AUTOMATIC_ATTEMPTS) return false;
    this.cancel();
    this.runtime.notify({ kind: "auto_resume", state: "exhausted" });
    return true;
  }

  private reserveForDelegates(): void {
    if (this.suppressed || !this.runtime.connected() || this.exhausted()) return;
    const at = this.reservationTime(this.latestRateLimit, this.latestRateLimit?.resetsAt);
    if (at !== undefined) this.reserve(at);
  }

  private reserve(at: number): void {
    if (this.pendingAt !== undefined && at <= this.pendingAt) return;
    if (this.timer !== undefined) this.runtime.clearTimer(this.timer);
    this.pendingAt = at;
    this.runtime.notify({ kind: "auto_resume", state: "pending", at });
    this.arm();
  }

  private clearReservation(): void {
    this.pendingMain = false;
    if (this.timer !== undefined) this.runtime.clearTimer(this.timer);
    this.timer = undefined;
    if (this.pendingAt !== undefined) {
      this.pendingAt = undefined;
      this.runtime.notify({ kind: "auto_resume", state: "cancelled" });
    }
  }

  private dropMain(): void {
    this.pendingMain = false;
    if (this.stoppedDelegates.size === 0) this.clearReservation();
  }

  private forgetDelegate(agentId: string): void {
    if (!this.stoppedDelegates.delete(agentId)) return;
    if (this.stoppedDelegates.size === 0 && !this.pendingMain) this.clearReservation();
  }

  private arm(delay?: number): void {
    const at = this.pendingAt;
    if (at === undefined) return;
    const timer = this.runtime.setTimer(() => {
      if (this.timer !== timer) return;
      this.timer = undefined;
      if (this.pendingAt !== at) return;
      if (!this.runtime.connected()) { this.cancel(); return; }
      if (this.runtime.now() >= at && !this.runtime.enabled()) { this.cancel(); return; }
      if (!this.runtime.live()) {
        this.dropMain();
        if (this.pendingAt !== at) return;
        this.arm(this.runtime.now() < at ? undefined : LIVENESS_TICK_MS);
        return;
      }
      if (this.runtime.now() < at) { this.arm(); return; }
      const text = usageLimitResumeText(this.pendingMain, [...this.stoppedDelegates]);
      this.pendingAt = undefined;
      this.pendingMain = false;
      this.stoppedDelegates.clear();
      this.attempts += 1;
      this.automaticTurn = true;
      this.runtime.notify({ kind: "auto_resume", state: "fired" });
      this.runtime.send(text);
    }, delay ?? Math.max(0, Math.min(LIVENESS_TICK_MS, at - this.runtime.now())));
    this.timer = timer;
  }
}
