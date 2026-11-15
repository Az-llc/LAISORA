const TRANSIENT_RETRY_MS = 2_000;
export const TRANSIENT_SYNC_RETRY_MS = 200;
const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code ?? "";

function retryDelayAfter(error: unknown, started: number, attempt: number, limitMs: number): number {
  const left = limitMs - (Date.now() - started);
  if (!TRANSIENT_FS_CODES.has(errorCode(error)) || left <= 0) throw error;
  return Math.min(10 * 2 ** attempt, 250, left);
}

export async function retryTransient<T>(action: () => Promise<T>): Promise<T> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      const ms = retryDelayAfter(error, started, attempt, TRANSIENT_RETRY_MS);
      await new Promise<void>(resolve => setTimeout(resolve, ms));
    }
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

export function retryTransientSync<T>(action: () => T): T {
  if (process.platform !== "win32") return action();
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try { return action(); }
    catch (error) {
      Atomics.wait(sleeper, 0, 0, retryDelayAfter(error, started, attempt, TRANSIENT_SYNC_RETRY_MS));
    }
  }
}
