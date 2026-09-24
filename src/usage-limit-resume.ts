import type { NormalizedEventBody } from "./protocol";

export const USAGE_LIMIT_CONTINUATION = "Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.";
export const SDK_AUTO_CONTINUE_SETTINGS = { autoContinueAtUsageLimit: false } as const;

type ResumeNotice = Extract<NormalizedEventBody, { kind: "auto_resume" }>;
interface ResumeRuntime {
  now(): number;
  random(): number;
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
  enabled(): boolean;
  live(): boolean;
  send(text: string): void;
  notify(event: ResumeNotice): void;
}

export class UsageLimitResume {
  private latestRateLimit?: Extract<NormalizedEventBody, { kind: "rate_limit" }>;
  private subscription = false;
  private timer: unknown;
  private pendingAt: number | undefined;
  private attempts = 0;
  private automaticTurn = false;
  private suppressed = false;
  private endedTurn: string | undefined;

  constructor(private readonly runtime: ResumeRuntime) {}

  cancel(): void {
    this.suppressed = true;
    if (this.timer !== undefined) this.runtime.clearTimer(this.timer);
    this.timer = undefined;
    if (this.pendingAt !== undefined) {
      this.pendingAt = undefined;
      this.runtime.notify({ kind: "auto_resume", state: "cancelled" });
    }
  }

  manualSend(): void {
    this.cancel();
    this.suppressed = false;
    this.automaticTurn = false;
    this.latestRateLimit = undefined;
  }

  observe(event: NormalizedEventBody): void {
    if (event.kind === "auth_status") this.subscription = event.auth.billingRealm === "subscription";
    if (event.kind === "rate_limit") this.latestRateLimit = event;
    if (event.kind === "conversation_closed" || event.kind === "turn_interrupted") this.cancel();
    if (event.kind === "turn_started") {
      this.endedTurn = undefined;
      if (this.pendingAt !== undefined) this.cancel();
    }
    if (event.kind === "turn_completed") {
      this.cancel();
      this.attempts = 0;
      this.automaticTurn = false;
      this.latestRateLimit = undefined;
      this.suppressed = false;
    }
    if (event.kind !== "turn_failed" || this.endedTurn === event.turnId) return;
    this.endedTurn = event.turnId;
    if (event.errorKind !== "usage_limit" || this.suppressed || this.pendingAt !== undefined) return;
    if (this.automaticTurn && this.attempts >= 3) {
      this.runtime.notify({ kind: "auto_resume", state: "exhausted" });
      this.suppressed = true;
      return;
    }
    const rate = this.latestRateLimit;
    const resetsAt = rate?.resetsAt ?? event.resetsAt;
    // R-CNV-25: only a live subscription rejection may create an automatic input.
    if (!this.runtime.live() || !this.runtime.enabled() || !this.subscription || rate?.status !== "rejected"
      || rate.isUsingOverage || rate.overageInUse === true || typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return;
    const at = resetsAt + 60_000 + Math.floor(this.runtime.random() * 60_001);
    if (at - this.runtime.now() > 86_400_000) return;
    this.pendingAt = at;
    this.runtime.notify({ kind: "auto_resume", state: "pending", at });
    this.arm();
  }

  private arm(): void {
    const at = this.pendingAt;
    if (at === undefined) return;
    this.timer = this.runtime.setTimer(() => {
      this.timer = undefined;
      if (this.pendingAt !== at) return;
      if (!this.runtime.live()) { this.cancel(); return; }
      if (this.runtime.now() < at) { this.arm(); return; }
      if (!this.runtime.enabled()) { this.cancel(); return; }
      this.pendingAt = undefined;
      this.attempts += 1;
      this.automaticTurn = true;
      this.runtime.notify({ kind: "auto_resume", state: "fired" });
      this.runtime.send(USAGE_LIMIT_CONTINUATION);
    }, Math.max(0, Math.min(60_000, at - this.runtime.now())));
  }
}
