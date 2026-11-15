import * as l10n from "@vscode/l10n";
import type { ClaudeConversation } from "./claudeHost";
import type { Session } from "./session";

export function sessionRecordId(s: { resumeSessionId?: string; auth?: { sessionId?: string } | null }): string | undefined {
  return s.resumeSessionId || s.auth?.sessionId || undefined;
}

export function hasSessionRecord(s: { resumeSessionId?: string; auth?: { sessionId?: string } | null }): boolean {
  return sessionRecordId(s) !== undefined;
}

export function noRecordReason(): string {
  return l10n.t("No session record yet (available once Claude Code has recorded this conversation)");
}

export function turnRunning(s: { readonly conversation: Pick<ClaudeConversation, "state"> | null }): boolean {
  return (s.conversation?.state ?? "idle") !== "idle";
}

export function isUnusedSession(s: Session): boolean {
  if (s.closed || s.clearing || s.resuming) return false;
  if (turnRunning(s)) return false;
  if (s.handoffSource !== undefined) return false;
  const used = s.events.some(
    (e) =>
      e.kind === "user_message" ||
      e.kind === "replayed_message" ||
      e.kind === "assistant_text_delta" ||
      e.kind === "tool_call_started" ||
      e.kind === "turn_started"
  );
  return !used;
}

export function resumableSessionId(s: Session): string | undefined {
  const sessionId = s.auth?.sessionId;
  return sessionId && !isUnusedSession(s) ? sessionId : undefined;
}
