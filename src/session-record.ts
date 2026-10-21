import * as l10n from "@vscode/l10n";

export function sessionRecordId(s: { resumeSessionId?: string; auth?: { sessionId?: string } | null }): string | undefined {
  return s.resumeSessionId || s.auth?.sessionId || undefined;
}

export function hasSessionRecord(s: { resumeSessionId?: string; auth?: { sessionId?: string } | null }): boolean {
  return sessionRecordId(s) !== undefined;
}

export function noRecordReason(): string {
  return l10n.t("No session record yet (available once Claude Code has recorded this conversation)");
}
