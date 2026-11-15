import { settingsEnvObject, transcriptWriteForbidden } from "./claude-env";
import { configuredSettingSources, newSessionCwd, resolveClaudeSettings, resolveSessionCwd, type ResolvedClaudeSettings } from "./claude-settings";
import { store } from "./host-context";
import { transcriptWriteLockedText } from "./protocol";
import type { Session } from "./session";

export class TranscriptWriteForbiddenError extends Error {
  constructor() {
    super(transcriptWriteLockedText());
  }
}

export function transcriptWriteLockOf(settings: ResolvedClaudeSettings | undefined): boolean {
  return transcriptWriteForbidden(process.env, settings === undefined ? undefined : settingsEnvObject(settings.env));
}

export function noteTranscriptWriteLock(s: Session, locked: boolean): boolean {
  if (s.transcriptWriteLocked !== locked) {
    s.transcriptWriteLocked = locked;
    store?.post({ type: "transcriptWriteLock", tabId: s.tabId, locked });
  }
  return locked;
}

export async function judgeTranscriptWriteLock(s: Session): Promise<boolean> {
  const cwd = s.conversation !== null && !s.conversation.isClosed && s.cwd.length > 0 ? s.cwd : resolveSessionCwd(s);
  const settings = cwd === undefined ? undefined : await resolveClaudeSettings(cwd, configuredSettingSources());
  return noteTranscriptWriteLock(s, transcriptWriteLockOf(settings));
}

export async function transcriptWriteLockedAt(cwd: string): Promise<boolean> {
  return transcriptWriteLockOf(await resolveClaudeSettings(cwd, configuredSettingSources()));
}

export function transcriptWriteLockedForNewTab(): Promise<boolean> {
  return transcriptWriteLockedAt(newSessionCwd());
}
