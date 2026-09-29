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
    // R-CNV-40: observedDelegateStops survives firing and cancellation until a resume is observed.
    if (this.observedDelegateStops.has(agentId)) return;
    this.observedDelegateStops.add(agentId);
    // R-CNV-41: cancel suppresses late stops as well as the existing reservation.
    if (this.suppressed) return;
    this.stoppedDelegates.add(agentId);
    // R-CNV-40: merge into pendingAt instead of allocating another reservation.
    if (this.pendingAt === undefined) this.reserveForDelegates();
  }

  observe(event: NormalizedEventBody): void {
    if (event.kind === "auth_status") this.subscription = event.auth.billingRealm === "subscription";
    if (event.kind === "rate_limit") {
      this.latestRateLimit = event;
      if (this.stoppedDelegates.size > 0) this.reserveForDelegates();
    }
    if (event.kind === "tool_call_finished") {
      // R-CNV-41: a successful resume retires the stop and permits a later stop of the same agent.
      if (!event.isError && event.resumedAgentId !== undefined) {
        this.observedDelegateStops.delete(event.resumedAgentId);
        this.forgetDelegate(event.resumedAgentId);
      }
      // R-CNV-40: repeated failed notifications must not cancel and recreate the reservation.
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
      // R-CNV-40: latestRateLimit may belong to a delegate whose stop notification is still in flight.
      // R-CNV-41: only manualSend lifts suppressed; main success does not undo cancellation.
    }
    if (event.kind !== "turn_failed" || this.endedTurn === event.turnId) return;
    this.endedTurn = event.turnId;
    // R-CNV-25 / R-CNV-26: only an eligible failure can add a main reservation.
    if (event.errorKind !== "usage_limit" || this.suppressed || (this.pendingAt !== undefined && this.pendingMain)) return;
    if (this.exhausted()) return;
    const rate = this.latestRateLimit;
    // R-CNV-25: the main failure is observed after the turn becomes idle.
    if (!this.runtime.live()) return;
    const at = this.reservationTime(rate, rate?.resetsAt ?? event.resetsAt);
    if (at === undefined) return;
    this.pendingMain = true;
    this.reserve(at);
  }

  // R-CNV-25 / R-CNV-40: reservationTime gates automatic inputs using rate and subscription.
  private reservationTime(rate: RateLimitNotice | undefined, resetsAt: number | null | undefined): number | undefined {
    if (!this.runtime.enabled() || !this.subscription || rate?.status !== "rejected"
      || rate.isUsingOverage || rate.overageInUse === true || typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return undefined;
    const at = resetsAt + 60_000 + Math.floor(this.runtime.random() * 60_001);
    return at - this.runtime.now() > 86_400_000 ? undefined : at;
  }

  // R-CNV-26 / R-CNV-41: MAX_AUTOMATIC_ATTEMPTS applies to the shared injection path.
  private exhausted(): boolean {
    if (!this.automaticTurn || this.attempts < MAX_AUTOMATIC_ATTEMPTS) return false;
    this.cancel();
    this.runtime.notify({ kind: "auto_resume", state: "exhausted" });
    return true;
  }

  // R-CNV-40 / R-CNV-41: reserveForDelegates shares reservationTime and exhausted with the main path.
  private reserveForDelegates(): void {
    if (this.suppressed || !this.runtime.connected() || this.exhausted()) return;
    const at = this.reservationTime(this.latestRateLimit, this.latestRateLimit?.resetsAt);
    if (at !== undefined) this.reserve(at);
  }

  private reserve(at: number): void {
    // R-CNV-40: coalescing must not fire before a later observed reset.
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

  // R-CNV-41: events that end the main reservation keep the delegate part.
  private dropMain(): void {
    this.pendingMain = false;
    // R-CNV-41: retiring pendingMain must not suppress later delegate notifications.
    if (this.stoppedDelegates.size === 0) this.clearReservation();
  }

  private forgetDelegate(agentId: string): void {
    // R-CNV-41: preserve any other stoppedDelegates and pendingMain.
    if (!this.stoppedDelegates.delete(agentId)) return;
    if (this.stoppedDelegates.size === 0 && !this.pendingMain) this.clearReservation();
  }

  private arm(delay?: number): void {
    const at = this.pendingAt;
    // R-CNV-26: clearReservation invalidates pending callbacks.
    if (at === undefined) return;
    const timer = this.runtime.setTimer(() => {
      // R-CNV-26 / R-CNV-40: ignore callbacks from a replaced or already fired timer.
      if (this.timer !== timer) return;
      this.timer = undefined;
      if (this.pendingAt !== at) return;
      // R-CNV-26 / R-CNV-41: connection loss cancels even while deferring.
      if (!this.runtime.connected()) { this.cancel(); return; }
      // R-CNV-26 / R-CNV-41: re-read settings at the deadline, including while busy.
      if (this.runtime.now() >= at && !this.runtime.enabled()) { this.cancel(); return; }
      if (!this.runtime.live()) {
        this.dropMain();
        if (this.pendingAt !== at) return;
        // R-CNV-41: a running main turn defers the delegate input instead of receiving it mid-turn.
        this.arm(this.runtime.now() < at ? undefined : LIVENESS_TICK_MS);
        return;
      }
      // R-CNV-25: LIVENESS_TICK_MS callbacks before the deadline cannot inject.
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
