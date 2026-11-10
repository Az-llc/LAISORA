import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { WAIT_NOTIFY_ALIVE_PREFIX, WAIT_NOTIFY_HEARTBEAT_FRESH_MS, WAIT_NOTIFY_HOOK_TIMEOUT_SECONDS } from "./wait-notify";

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function bellDirOwner(name: string): number | undefined {
  const match = /^(\d+)-/.exec(name);
  return match === null ? undefined : Number(match[1]);
}

function newestMtime(dir: string): number {
  let newest = fs.statSync(dir).mtimeMs;
  for (const name of fs.readdirSync(dir)) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
    } catch {
      newest = Math.max(newest, Date.now());
    }
  }
  return newest;
}

export function sweepStaleBells(root: string, now: number, alive: (pid: number) => boolean = processAlive, keep?: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const owner = bellDirOwner(entry.name);
    if (dir === keep || owner === undefined || alive(owner)) continue;
    try {
      if (now - newestMtime(dir) < WAIT_NOTIFY_HOOK_TIMEOUT_SECONDS * 1000) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      continue;
    }
  }
  return removed;
}

export function createBellDir(root: string, ownerPid: number, now: number, alive: (pid: number) => boolean = processAlive): string {
  fs.mkdirSync(root, { recursive: true });
  sweepStaleBells(root, now, alive);
  const dir = path.join(root, `${ownerPid}-${randomUUID()}`);
  fs.mkdirSync(dir);
  return dir;
}

export function writeBellFile(dir: string, name: string, text: string): void {
  const file = path.join(dir, name);
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

export function removeBellFile(dir: string, name: string): void {
  fs.rmSync(path.join(dir, name), { force: true });
}

export function bellFileExists(dir: string, name: string): boolean {
  return fs.existsSync(path.join(dir, name));
}

export function bellHookAlive(dir: string, now: number): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((name) => {
    if (!name.startsWith(WAIT_NOTIFY_ALIVE_PREFIX)) return false;
    try {
      return now - fs.statSync(path.join(dir, name)).mtimeMs <= WAIT_NOTIFY_HEARTBEAT_FRESH_MS;
    } catch {
      return false;
    }
  });
}

export function writeBellScript(file: string, text: string): void {
  let current: string | undefined;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    current = undefined;
  }
  if (current === text) return;
  writeBellFile(path.dirname(file), path.basename(file), text);
}
