import { randomBytes } from "node:crypto";
import { mkdirSync, watch } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyTodoOperation, emptyTodoDocument, parseTodoDocument, todoDocumentJson, pruneDeletedItems, liveImageNames, TODO_IMAGE_EXTENSIONS, TODO_IMAGE_FILE, todoImageRefs, type TodoAuthor, type TodoImageRef, type TodoImageMediaType, type TodoDocument, type TodoOperation, type TodoOperationResult } from "./todo-model";

export const TODO_KEPT_REVISIONS = 20;
export const TODO_WRITE_WINDOW = 200;
const TODO_WRITE_ATTEMPTS = 100;
const TODO_READ_ATTEMPTS = 5;
const TODO_WATCH_DEBOUNCE_MS = 50;
const TRANSIENT_RETRY_MS = 2_000;
const TODO_UNCOMMITTED_FILE_MS = 10 * 60_000;
const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const REVISION_FILE = /^todo\.(\d+)\.json$/;
const TEMP_FILE = /^todo\.json\.(\d+)\.[0-9a-f]+\.tmp$/;

export const todoRevisionFile = (revision: number) => `todo.${revision}.json`;

export type TodoStoreErrorCode = "corrupt" | "conflict" | "uncertain" | "io";

export class TodoStoreError extends Error {
  constructor(readonly code: TodoStoreErrorCode, readonly detail?: unknown) {
    super(`TODO store ${code}`);
  }
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code ?? "";

async function retryTransient<T>(action: () => Promise<T>): Promise<T> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if (!TRANSIENT_FS_CODES.has(errorCode(error)) || Date.now() - started >= TRANSIENT_RETRY_MS) throw error;
      await delay(Math.min(10 * 2 ** attempt, 250));
    }
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) === "EPERM"; }
}

export class TodoStore {
  private readonly corruptLogged = new Set<number>();
  private readonly heldLogged = new Set<number>();
  private readonly imageRefs = new Map<number, readonly TodoImageRef[]>();

  constructor(readonly directory: string, private readonly log: (message: string) => void = () => {}) {}

  async read(): Promise<TodoDocument> {
    const document = await this.load();
    return { ...document, items: pruneDeletedItems(document.items, Date.now()) };
  }

  async apply(operation: TodoOperation, author: TodoAuthor): Promise<TodoOperationResult> {
    try { await mkdir(this.directory, { recursive: true }); }
    catch (error) { throw new TodoStoreError("io", error); }
    const writeId = randomBytes(6).toString("hex");
    for (let attempt = 0; attempt < TODO_WRITE_ATTEMPTS; attempt++) {
      const current = await this.read();
      const result = applyTodoOperation(current, operation, { author, now: Date.now(), newId: taken => {
        for (;;) { const id = randomBytes(4).toString("hex"); if (!taken.has(id)) return id; }
      } });
      if (!result.ok || result.document === current) return result;
      const document: TodoDocument = { ...result.document, writes: [...(current.writes ?? []), writeId].slice(-TODO_WRITE_WINDOW) };
      if (await this.publish(document)) {
        const placement = await this.placement(document.revision, writeId).catch(() => "uncertain" as const);
        if (placement === "visible") {
          await this.prune(document.revision);
          await this.collectFiles(document).catch(error => this.log(`[todo] could not clean up image files: ${String(error)}`));
          return { ...result, document };
        }
        if (placement === "uncertain") throw new TodoStoreError("uncertain");
        await this.removeOwnRevision(document.revision, writeId);
        this.log(`[todo] ${todoRevisionFile(document.revision)} was published after its revision had been pruned; writing again`);
      }
      await delay(1 + Math.random() * Math.min(5 * (attempt + 1), 50));
    }
    throw new TodoStoreError("conflict");
  }

  watch(listener: (revision: number) => void): { dispose(): void } {
    mkdirSync(this.directory, { recursive: true });
    let last: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const check = async () => {
      try {
        const highest = (await this.revisions())[0] ?? 0;
        if (disposed || last === undefined || highest <= last) { last ??= highest; return; }
        last = highest;
        listener(highest);
      } catch (error) { this.log(`[todo] could not list the store after a change: ${String(error)}`); }
    };
    void check();
    const watcher = watch(this.directory, (_event, name) => {
      if (name !== null && !REVISION_FILE.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void check(), TODO_WATCH_DEBOUNCE_MS);
    });
    watcher.on("error", error => this.log(`[todo] store watcher failed: ${String(error)}`));
    return { dispose: () => { disposed = true; clearTimeout(timer); watcher.close(); } };
  }

  private async revisions(): Promise<number[]> {
    let names: string[];
    try { names = await retryTransient(() => readdir(this.directory)); }
    catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw new TodoStoreError("io", error);
    }
    return names.flatMap(name => {
      const match = REVISION_FILE.exec(name);
      return match ? [Number(match[1])] : [];
    }).filter(Number.isSafeInteger).sort((a, b) => b - a);
  }

  private async load(): Promise<TodoDocument> {
    for (let attempt = 0; attempt < TODO_READ_ATTEMPTS; attempt++) {
      const revisions = await this.revisions();
      if (revisions.length === 0) return emptyTodoDocument();
      let vanished = false;
      for (const revision of revisions) {
        let text: string;
        try { text = await retryTransient(() => readFile(join(this.directory, todoRevisionFile(revision)), "utf8")); }
        catch (error) {
          if (errorCode(error) === "ENOENT") { vanished = true; break; }
          throw new TodoStoreError("io", error);
        }
        try {
          return { ...parseTodoDocument(text, count => {
            if (!this.heldLogged.has(revision)) this.log(`[todo] ${todoRevisionFile(revision)}: ${count} unreadable value(s) kept in the file and left out of the view`);
            this.heldLogged.add(revision);
          }), revision: revisions[0] };
        }
        catch {
          if (!this.corruptLogged.has(revision)) this.log(`[todo] ${todoRevisionFile(revision)} could not be read; using an earlier revision`);
          this.corruptLogged.add(revision);
        }
      }
      if (!vanished) throw new TodoStoreError("corrupt");
    }
    throw new TodoStoreError("io");
  }

  private async publish(document: TodoDocument): Promise<boolean> {
    const temp = join(this.directory, `todo.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await retryTransient(async () => {
        const handle = await open(temp, "w");
        try {
          await handle.writeFile(todoDocumentJson(document));
          await handle.sync();
        } finally { await handle.close(); }
      });
      await retryTransient(() => link(temp, join(this.directory, todoRevisionFile(document.revision))));
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw new TodoStoreError("io", error);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async placement(revision: number, writeId: string): Promise<"visible" | "stray" | "uncertain"> {
    const current = await this.read();
    if (current.writes?.includes(writeId)) return "visible";
    return current.revision - revision < TODO_WRITE_WINDOW ? "stray" : "uncertain";
  }

  private async removeOwnRevision(revision: number, writeId: string): Promise<void> {
    const file = join(this.directory, todoRevisionFile(revision));
    const aside = join(this.directory, `todo.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try { await retryTransient(() => rename(file, aside)); }
    catch { return; }
    const text = await readFile(aside, "utf8").catch(() => "");
    let ours = false;
    try { ours = (JSON.parse(text) as TodoDocument).writes?.at(-1) === writeId; } catch {}
    if (!ours) await link(aside, file).catch(error => this.log(`[todo] could not put back ${todoRevisionFile(revision)}: ${String(error)}`));
    await rm(aside, { force: true }).catch(() => undefined);
  }

  get filesDirectory(): string {
    return join(this.directory, "files");
  }

  async writeImage(mediaType: TodoImageMediaType, data: Buffer): Promise<string> {
    const name = `${Date.now()}-${randomBytes(4).toString("hex")}.${TODO_IMAGE_EXTENSIONS[mediaType]}`;
    try {
      await mkdir(this.filesDirectory, { recursive: true });
      await retryTransient(() => writeFile(join(this.filesDirectory, name), data, { flag: "wx" }));
    } catch (error) { throw new TodoStoreError("io", error); }
    return name;
  }

  async readImage(name: string): Promise<Buffer | undefined> {
    if (!TODO_IMAGE_FILE.test(name)) return undefined;
    try { return await retryTransient(() => readFile(join(this.filesDirectory, name))); }
    catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw new TodoStoreError("io", error);
    }
  }

  async removeImage(name: string): Promise<void> {
    if (TODO_IMAGE_FILE.test(name)) await rm(join(this.filesDirectory, name), { force: true }).catch(() => undefined);
  }

  private async collectFiles(document: TodoDocument): Promise<void> {
    const names = await readdir(this.filesDirectory).catch(() => [] as string[]);
    if (!names.some(name => TODO_IMAGE_FILE.test(name))) return;
    const now = Date.now();
    const kept = liveImageNames(todoImageRefs(document), now);
    this.imageRefs.set(document.revision, todoImageRefs(document));
    const revisions = await this.revisions();
    for (const cached of this.imageRefs.keys()) if (!revisions.includes(cached)) this.imageRefs.delete(cached);
    for (const revision of revisions) {
      if (revision === document.revision) continue;
      let refs = this.imageRefs.get(revision);
      if (!refs) {
        try { refs = todoImageRefs(parseTodoDocument(await readFile(join(this.directory, todoRevisionFile(revision)), "utf8"))); }
        catch (error) {
          if (errorCode(error) === "ENOENT") continue;
          return;
        }
        this.imageRefs.set(revision, refs);
      }
      for (const name of liveImageNames(refs, now)) kept.add(name);
    }
    for (const name of names) {
      const written = TODO_IMAGE_FILE.exec(name);
      if (!written || kept.has(name) || Date.now() - Number(written[1]) < TODO_UNCOMMITTED_FILE_MS) continue;
      await rm(join(this.filesDirectory, name), { force: true }).catch(error => this.log(`[todo] could not remove ${name}: ${String(error)}`));
    }
  }

  private async prune(written: number): Promise<void> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    for (const name of names) {
      const revision = REVISION_FILE.exec(name);
      const temp = TEMP_FILE.exec(name);
      const stale = revision ? Number(revision[1]) <= written - TODO_KEPT_REVISIONS : temp ? !processAlive(Number(temp[1])) : false;
      if (stale) await rm(join(this.directory, name), { force: true }).catch(error => this.log(`[todo] could not remove ${name}: ${String(error)}`));
    }
  }
}

export const TODO_ENABLED_SETTING = "todo.enabled";
const openStores = new Map<string, TodoStore>();

export function sharedTodoStore(globalStoragePath: string | undefined, log?: (message: string) => void): TodoStore | undefined {
  if (!globalStoragePath) return undefined;
  const directory = join(globalStoragePath, "todo");
  let store = openStores.get(directory);
  if (!store) openStores.set(directory, store = new TodoStore(directory, log));
  return store;
}
