import * as l10n from "@vscode/l10n";

export function sessionRecordId(s: { resumeSessionId?: string; auth?: { sessionId?: string } | null }): string | undefined {
  return s.resumeSessionId || s.auth?.sessionId || undefined;
}

export function hasSessionRecord(s: { resumeSessionId?: string; auth?: { sessionId?: string } | null }): boolean {
  return sessionRecordId(s) !== undefined;
}

export function noRecordRefusal(): string {
  return l10n.t("LAISORA: The session ID is not available yet (analysis is available after the first message is sent).");
}

export function noRecordReason(): string {
  return l10n.t("No session record yet (available once Claude Code has recorded this conversation)");
}
