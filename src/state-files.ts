import { readdir, readFile, stat, unlink } from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-file";
import { hasWindowsReservedDeviceName } from "./file-link-target";
import { errorCode, retryTransient } from "./transient-fs";

const STATE_FILE_NAME_MAX_LENGTH = 200;
const STATE_FILE_NAME_CHAR = /[a-z0-9_-]/;
const STATE_FILE_NAME = /^(?:[a-z0-9_-]|%[0-9A-F]{2})+$/;

function percentByte(byte: number): string {
  return "%" + byte.toString(16).toUpperCase().padStart(2, "0");
}

export function stateFileName(id: string): string | undefined {
  let name = "";
  for (const byte of Buffer.from(id, "utf8")) {
    const char = String.fromCharCode(byte);
    name += STATE_FILE_NAME_CHAR.test(char) ? char : percentByte(byte);
  }
  if (hasWindowsReservedDeviceName(name)) name = percentByte(name.charCodeAt(0)) + name.slice(1);
  return name.length > 0 && name.length <= STATE_FILE_NAME_MAX_LENGTH ? name : undefined;
}

function stateFileIdOf(name: string): string | undefined {
  if (!STATE_FILE_NAME.test(name)) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(name);
  } catch {
    return undefined;
  }
  return stateFileName(id) === name ? id : undefined;
}

export function isStateFileId(id: string): boolean {
  return stateFileName(id) !== undefined;
}

function storageUnavailable(): Error {
  return new Error("the extension storage folder is unavailable");
}

class EntryFiles {
  constructor(private readonly directory: string | undefined, private readonly suffix: string) {}

  private fileOf(id: string): string | undefined {
    const name = stateFileName(id);
    return this.directory === undefined || name === undefined ? undefined : path.join(this.directory, name + this.suffix);
  }

  async ids(): Promise<string[]> {
    const directory = this.directory;
    if (directory === undefined) return [];
    let names: string[];
    try {
      names = await retryTransient(() => readdir(directory));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    return names
      .filter((name) => name.endsWith(this.suffix))
      .map((name) => stateFileIdOf(name.slice(0, name.length - this.suffix.length)))
      .filter((id): id is string => id !== undefined);
  }

  async read(id: string): Promise<string | undefined> {
    const file = this.fileOf(id);
    if (file === undefined) return undefined;
    try {
      return await retryTransient(() => readFile(file, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  async has(id: string): Promise<boolean> {
    const file = this.fileOf(id);
    if (file === undefined) return false;
    try {
      await retryTransient(() => stat(file));
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  async write(id: string, contents: string): Promise<void> {
    if (this.directory === undefined) throw storageUnavailable();
    const file = this.fileOf(id);
    if (file === undefined) throw new Error(`not usable as a file name: ${JSON.stringify(id)}`);
    await retryTransient(() => writeFileAtomic(file, contents));
  }

  async remove(id: string): Promise<void> {
    const file = this.fileOf(id);
    if (file === undefined) return;
    try {
      await retryTransient(() => unlink(file));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

function within(root: string | undefined, ...parts: string[]): string | undefined {
  return root === undefined ? undefined : path.join(root, ...parts);
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export type HandoffRegistryName = "inFlight" | "orphans";

const HANDOFF_REGISTRY_DIRECTORIES: Readonly<Record<HandoffRegistryName, readonly string[]>> = {
  inFlight: ["handoff", "in-flight"],
  orphans: ["handoff", "orphans"],
};

export interface HandoffRegistryListing {
  entries: unknown[];
  unreadable: boolean;
  malformed: number;
}

export interface HandoffRegistry {
  list(name: HandoffRegistryName): Promise<HandoffRegistryListing>;
  count(name: HandoffRegistryName): Promise<number>;
  has(name: HandoffRegistryName, runId: string): Promise<boolean>;
  put(name: HandoffRegistryName, entry: { runId: string }): Promise<void>;
  remove(name: HandoffRegistryName, runId: string): Promise<void>;
}

export function handoffRegistryFiles(root: string | undefined): HandoffRegistry {
  const files = (name: HandoffRegistryName): EntryFiles =>
    new EntryFiles(within(root, ...HANDOFF_REGISTRY_DIRECTORIES[name]), ".json");
  return {
    async list(name) {
      const directory = files(name);
      let ids: string[];
      try {
        ids = await directory.ids();
      } catch {
        return { entries: [], unreadable: true, malformed: 0 };
      }
      const entries: unknown[] = [];
      let unreadable = false;
      let malformed = 0;
      for (const id of ids) {
        let text: string | undefined;
        try {
          text = await directory.read(id);
        } catch {
          unreadable = true;
          continue;
        }
        if (text === undefined) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(text);
        } catch {
          malformed++;
          continue;
        }
        if (asObject(entry)?.runId === id) entries.push(entry);
        else malformed++;
      }
      return { entries, unreadable, malformed };
    },
    count: async (name) => (await files(name).ids()).length,
    has: (name, runId) => files(name).has(runId),
    put: (name, entry) => files(name).write(entry.runId, JSON.stringify(entry)),
    remove: (name, runId) => files(name).remove(runId),
  };
}

export interface LegacyMemento {
  get(key: string): unknown;
  update(key: string, value: unknown): Promise<void>;
}

export async function foldLegacyEntries<T>(
  legacy: LegacyMemento,
  key: string,
  entries: readonly T[],
  move: (entry: T) => Promise<void>,
  moveFailed: (entry: T, error: unknown) => void,
  parallel = 1
): Promise<void> {
  let folded = true;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      const entry = entries[next++];
      try {
        await move(entry);
      } catch (error) {
        folded = false;
        moveFailed(entry, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, entries.length)) }, worker));
  if (folded) await legacy.update(key, undefined);
}

export interface HandoffContextStore {
  read(forkSessionId: string): Promise<unknown>;
  write(forkSessionId: string, contextUsage: unknown): Promise<void>;
  remove(forkSessionId: string): Promise<void>;
}

const HANDOFF_CONTEXT_DIRECTORY = "handoff-context";

export function handoffContextFiles(
  root: string | undefined,
  legacy: LegacyMemento,
  legacyKey: (forkSessionId: string) => string
): HandoffContextStore {
  const files = new EntryFiles(within(root, HANDOFF_CONTEXT_DIRECTORY), ".json");
  return {
    async read(forkSessionId) {
      const text = await files.read(forkSessionId);
      if (text === undefined) return legacy.get(legacyKey(forkSessionId));
      return asObject(JSON.parse(text))?.contextUsage;
    },
    write: (forkSessionId, contextUsage) => files.write(forkSessionId, JSON.stringify({ contextUsage })),
    async remove(forkSessionId) {
      await files.remove(forkSessionId);
      const key = legacyKey(forkSessionId);
      if (legacy.get(key) !== undefined) await legacy.update(key, undefined);
    },
  };
}

export interface UsedSessionStore {
  ids(): Promise<string[]>;
  add(sessionId: string): Promise<void>;
}

const USED_SESSIONS_DIRECTORY = "used-sessions";

export function usedSessionFiles(root: string | undefined): UsedSessionStore {
  const files = new EntryFiles(within(root, USED_SESSIONS_DIRECTORY), "");
  return {
    ids: () => files.ids(),
    async add(sessionId) {
      if (await files.has(sessionId)) return;
      await files.write(sessionId, "");
    },
  };
}
