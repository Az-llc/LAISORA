export type ComposerTurnState = "idle" | "running" | "interrupting";

export type ComposerLockReason = "handoff" | "transcriptWrite";

export interface ComposerActionState {
  action: "send" | "stop";
  disabled: boolean;
}

export function composerLockOf(locks: { handoffSendLocked: boolean; transcriptWriteLocked: boolean }): ComposerLockReason | null {
  if (locks.transcriptWriteLocked) return "transcriptWrite";
  return locks.handoffSendLocked ? "handoff" : null;
}

export function composerActionState(turnState: ComposerTurnState, locked: boolean): ComposerActionState {
  if (turnState === "idle") return { action: "send", disabled: locked };
  return { action: "stop", disabled: turnState === "interrupting" };
}
