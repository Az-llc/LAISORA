import { failClosedGuard } from "./guard-evaluation";
import type * as Sdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

const TOOL_USE_META_KEY = "claudecode/toolUseId";
const ROOT_MARK_TTL_MS = 5 * 60_000;
const ROOT_MARK_HOLD_MS = 30 * 60_000;
const ROOT_MARK_CAP = 32;

export interface RootGateScope {
  readonly tools: readonly string[];
  readonly denial: string;
}

export class RootGate {
  private readonly marks = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now, private readonly log: (message: string) => void = () => {},
    readonly scope: RootGateScope) {}

  readonly hook: Sdk.HookCallback = async (input) => {
    const value = input as unknown as Record<string, unknown>;
    if (!this.scope.tools.includes(String(value.tool_name))) return {};
    if (value.hook_event_name !== "PreToolUse") { this.revoke(value.tool_use_id); return {}; }
    return failClosedGuard(() => {
      if (value.agent_id !== undefined) {
        return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const,
          permissionDecisionReason: this.scope.denial } };
      }
      if (typeof value.tool_use_id === "string" && value.tool_use_id) this.mark(value.tool_use_id);
      return {};
    }, this.log);
  };

  private mark(id: string): void {
    for (const [key, expiry] of this.marks) if (expiry <= this.now()) this.marks.delete(key);
    this.marks.delete(id);
    this.marks.set(id, this.now() + ROOT_MARK_TTL_MS);
    for (const key of this.marks.keys()) {
      if (this.marks.size <= ROOT_MARK_CAP) break;
      this.marks.delete(key);
    }
  }

  private live(id: string): boolean {
    const expiry = this.marks.get(id);
    if (expiry !== undefined && expiry > this.now()) return true;
    this.marks.delete(id);
    return false;
  }

  hold(id: unknown): void { if (typeof id === "string" && this.live(id)) this.marks.set(id, this.now() + ROOT_MARK_HOLD_MS); }
  release(id: unknown): void { if (typeof id === "string" && this.live(id)) this.marks.set(id, this.now() + ROOT_MARK_TTL_MS); }
  revoke(id: unknown): void { if (typeof id === "string") this.marks.delete(id); }
  clear(): void { this.marks.clear(); }

  consume(extra: unknown): boolean {
    const meta = extra && typeof extra === "object" ? (extra as { _meta?: unknown })._meta : undefined;
    const id = meta && typeof meta === "object" ? (meta as Record<string, unknown>)[TOOL_USE_META_KEY] : undefined;
    if (typeof id !== "string" || !this.live(id)) return false;
    this.marks.delete(id);
    return true;
  }
}
