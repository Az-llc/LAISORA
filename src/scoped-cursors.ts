import { randomUUID } from "node:crypto";

export interface CursorPosition<P> {
  scopeKey: string;
  position: P;
}

export interface ScopedCursors<R, P extends string | number> {
  readonly scopes: ReadonlyMap<string, R>;
  readonly cursorCount: () => number;
  register(scopeKey: string, registration: R, scopeMax: number): void;
  release(scopeKey: string): void;
  has(scopeKey: string): boolean;
  touch(scopeKey: string): R;
  cursorFor(scopeKey: string, position: P): string;
  cursorAt(token: string): CursorPosition<P> | undefined;
  clear(): void;
}

export function createScopedCursors<R, P extends string | number>(cursorMax: number, unavailable: () => Error): ScopedCursors<R, P> {
  const scopes = new Map<string, R>();
  const cursors = new Map<string, CursorPosition<P>>();
  const cursorTokens = new Map<string, string>();
  const dedupeKey = (scopeKey: string, position: P): string => `${scopeKey} ${position}`;
  const dropCursor = (token: string): void => {
    const state = cursors.get(token);
    cursors.delete(token);
    if (state === undefined) return;
    const key = dedupeKey(state.scopeKey, state.position);
    if (cursorTokens.get(key) === token) cursorTokens.delete(key);
  };
  const dropScope = (scopeKey: string): void => {
    scopes.delete(scopeKey);
    for (const [token, state] of cursors) {
      if (state.scopeKey === scopeKey) dropCursor(token);
    }
  };
  return {
    scopes,
    cursorCount: () => cursors.size,
    register(scopeKey, registration, scopeMax) {
      scopes.delete(scopeKey);
      scopes.set(scopeKey, registration);
      while (scopes.size > scopeMax) {
        const oldest = scopes.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        dropScope(oldest);
      }
    },
    release: dropScope,
    has: (scopeKey) => scopes.has(scopeKey),
    touch(scopeKey) {
      const registration = scopes.get(scopeKey);
      if (registration === undefined) throw unavailable();
      scopes.delete(scopeKey);
      scopes.set(scopeKey, registration);
      return registration;
    },
    cursorFor(scopeKey, position) {
      const key = dedupeKey(scopeKey, position);
      const existing = cursorTokens.get(key);
      if (existing !== undefined && cursors.has(existing)) return existing;
      const token = randomUUID();
      cursors.set(token, { scopeKey, position });
      cursorTokens.set(key, token);
      while (cursors.size > cursorMax) {
        const oldest = cursors.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        dropCursor(oldest);
      }
      return token;
    },
    cursorAt: (token) => cursors.get(token),
    clear() {
      scopes.clear();
      cursors.clear();
      cursorTokens.clear();
    },
  };
}
