import type { Session } from "./session";

const listeners = new Set<(s: Session) => void>();

export function onWaitNotifySignal(listener: (s: Session) => void): void {
  listeners.add(listener);
}

export function signalWaitNotify(s: Session): void {
  for (const listener of listeners) listener(s);
}
