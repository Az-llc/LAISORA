import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  archiveCommands, archiveExcludeList, claudeEnvEntries, claudeEnvPathsRemapped, claudeSettingsKeyFields, conversationFileKept, conversationTarget, exportedProjectFolder, folderHoldingAllSessions, sessionsAlreadyPresent, extractCommand, folderCwd, importPlacement,
  isSessionFileName, mcpServersWithKeys, mergedGlobalConfig, migrationReadme, parseMigrationManifest, projectFileCategory, projectsArchive, normalizedWorkFolder, projectsTotals, sameFolderName, relocatedGroupBindings, relocatedRecord, remapJsonPaths, remapTodoDocument, userMcpServers,
  MEMORY_DIR, MIGRATION_DIR, MIGRATION_FORMAT, MIGRATION_MANIFEST, MIGRATION_MCP_SERVERS, MIGRATION_README, MIGRATION_SETTINGS, MIGRATION_TODO, MIGRATION_TODO_FILES, PROJECTS_DIR,
  type ArchiverCommand, type MigrationCounts, type MigrationManifest, type MigrationManifestFolder, type ProjectFileCategory, type ProjectFolderInventory, type ProjectsTotals,
} from "./migration-plan";
import { claudeProjectDirName } from "./claude-env";
import { isProjectDirName, type MigrationCategory, type MigrationProgress } from "./migration-categories";
import { recordCwds } from "./session-display-title";
import { lastRelocatedCwd, readCwdWindowLines } from "./transcript-cwd";
import { liveImageNames, parseTodoDocument, todoDocumentJson, todoFolderKey, todoGroupsOf, todoImageRefs } from "./todo-model";
import { retryTransient, type TodoStore } from "./todo-store";

export interface MigrationPlace {
  readonly configDir: string;
  readonly globalConfigFile: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly todoStore?: TodoStore;
}

export type MigrationProgressReport = (update: Pick<MigrationProgress, "phase" | "done" | "total">) => void;

export type MigrationErrorCode = "archiverMissing" | "archiverFailed" | "notMigration" | "exists" | "brokenLink";

export class MigrationError extends Error {
  constructor(readonly code: MigrationErrorCode, readonly detail = "") {
    super(`migration ${code}${detail ? `: ${detail}` : ""}`);
  }
}

export interface MigrationScan extends ProjectsTotals {
  readonly todo?: { readonly items: number; readonly bytes: number };
  readonly laisoraSettings: number;
  readonly claudeEnv: { readonly files: number; readonly bytes: number; readonly mcpServers: number; readonly mcpKeyServers: readonly string[]; readonly settingsKeyFiles: readonly string[] };
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code ?? "";
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

async function* walkFiles(root: string, segments: readonly string[] = [], follow = false): AsyncGenerator<readonly string[]> {
  let entries;
  try { entries = await readdir(join(root, ...segments), { withFileTypes: true }); }
  catch (error) { if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return; throw error; }
  for (const entry of entries) {
    const directory = entry.isDirectory() || follow && entry.isSymbolicLink() && (await stat(join(root, ...segments, entry.name)).catch(() => undefined))?.isDirectory();
    if (directory) yield* walkFiles(root, [...segments, entry.name], follow);
    else yield [...segments, entry.name];
  }
}

async function treeSize(root: string, names: readonly string[]): Promise<{ files: number; bytes: number }> {
  let files = 0, bytes = 0;
  for (const name of names) {
    const info = await stat(join(root, name)).catch(() => undefined);
    if (!info) continue;
    if (!info.isDirectory()) { files++; bytes += info.size; continue; }
    for await (const segments of walkFiles(join(root, name), [], true)) {
      files++;
      bytes += (await stat(join(root, name, ...segments)).catch(() => undefined))?.size ?? 0;
    }
  }
  return { files, bytes };
}

const readText = (path: string) => readFile(path, "utf8").catch(() => undefined);
const sessionFiles = async (folder: string) => (await readdir(folder).catch(() => [] as string[])).filter(isSessionFileName);

async function folderCwdOf(folder: string, dirName: string): Promise<string | undefined> {
  for (const name of await sessionFiles(folder)) {
    const lines = await readCwdWindowLines(join(folder, name)).catch(() => undefined);
    if (!lines) continue;
    const cwd = folderCwd(dirName, lastRelocatedCwd(lines).cwd, recordCwds(lines));
    if (cwd !== undefined) return cwd;
  }
  return undefined;
}

const isSessionFile = (segments: readonly string[]) => segments.length === 1 && isSessionFileName(segments[0]);

async function projectsInventory(place: MigrationPlace, onFolder?: (done: number, total: number) => void): Promise<ProjectFolderInventory[]> {
  const projects = join(place.configDir, PROJECTS_DIR);
  const folders: ProjectFolderInventory[] = [];
  const names = (await readdir(projects).catch(() => [] as string[])).filter(isProjectDirName).sort();
  for (const [index, dirName] of names.entries()) {
    onFolder?.(index, names.length);
    const folder = join(projects, dirName);
    if (!(await stat(folder).catch(() => undefined))?.isDirectory()) continue;
    let sessions = 0, conversationFiles = 0, conversationBytes = 0, memoryFiles = 0, memoryBytes = 0;
    for await (const segments of walkFiles(folder, [], true)) {
      const size = (await stat(join(folder, ...segments)).catch(() => undefined))?.size ?? 0;
      if (projectFileCategory(segments) === "memory") { memoryFiles++; memoryBytes += size; continue; }
      conversationFiles++;
      conversationBytes += size;
      if (isSessionFile(segments)) sessions++;
    }
    folders.push({ dirName, sessions, conversationFiles, conversationBytes, memoryFiles, memoryBytes });
  }
  return folders;
}

async function settingsKeyFilesOf(place: MigrationPlace): Promise<string[]> {
  const files: string[] = [];
  for (const name of ["settings.json", "settings.local.json"]) {
    const fields = claudeSettingsKeyFields(await readText(join(place.configDir, name)));
    if (fields.length) files.push(`${name} (${fields.join(", ")})`);
  }
  return files;
}

async function presentClaudeEnv(place: MigrationPlace): Promise<string[]> {
  return claudeEnvEntries(await readdir(place.configDir).catch(() => [] as string[]));
}

async function todoExport(store: TodoStore) {
  const document = await store.read();
  const images = [...liveImageNames(todoImageRefs(document), Date.now())];
  return { document, images, items: document.items.filter(item => item.deletedAt === undefined).length };
}

export async function scanMigration(place: MigrationPlace, laisoraSettings: number): Promise<MigrationScan> {
  const todo = place.todoStore ? await todoExport(place.todoStore).catch(() => undefined) : undefined;
  let todoBytes = 0;
  if (todo && place.todoStore) {
    todoBytes = Buffer.byteLength(todoDocumentJson(todo.document));
    for (const name of todo.images) todoBytes += (await stat(join(place.todoStore.filesDirectory, name)).catch(() => undefined))?.size ?? 0;
  }
  const env = await treeSize(place.configDir, await presentClaudeEnv(place));
  const servers = userMcpServers(await readText(place.globalConfigFile));
  const settingsKeyFiles = await settingsKeyFilesOf(place);
  const inventory = await projectsInventory(place);
  return {
    ...(todo ? { todo: { items: todo.items, bytes: todoBytes } } : {}),
    laisoraSettings,
    claudeEnv: { files: env.files, bytes: env.bytes, mcpServers: Object.keys(servers).length, mcpKeyServers: mcpServersWithKeys(servers), settingsKeyFiles },
    ...projectsTotals(inventory),
  };
}

function runArchiver(command: ArchiverCommand, onEntry?: (path: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.args], { cwd: command.cwd, windowsHide: true, stdio: [command.stdinFile ? "pipe" : "ignore", "ignore", "pipe"] });
    if (command.stdinFile && child.stdin) {
      child.stdin.on("error", () => undefined);
      createReadStream(command.stdinFile).on("error", error => { child.kill(); reject(new MigrationError("archiverFailed", String(error))); }).pipe(child.stdin);
    }
    let partial = "";
    const tail: string[] = [];
    const take = (line: string) => {
      const entry = command.reportsEntries ? ARCHIVER_ENTRY_LINE.exec(line) : null;
      if (entry) { onEntry?.(entry[1]); return; }
      if (line.trim() === "") return;
      tail.push(line.trim());
      if (tail.length > 3) tail.shift();
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      const lines = (partial + chunk.toString()).split(/\r?\n/);
      partial = lines.pop() ?? "";
      lines.forEach(take);
    });
    child.on("error", error => reject(errorCode(error) === "ENOENT" ? new MigrationError("archiverMissing", command.command) : new MigrationError("archiverFailed", String(error))));
    child.on("close", code => {
      take(partial);
      if (code === 0) resolve(); else reject(new MigrationError("archiverFailed", `${basename(command.command)} exit ${code}: ${tail.join(" / ")}`));
    });
  });
}

const ARCHIVER_ENTRY_LINE = /^[ax] (.+)$/;

async function archiveEntryCount(root: string, name: string, keepClosed?: string, ancestors: ReadonlySet<string> = new Set()): Promise<number> {
  const path = join(root, name);
  const info = await stat(path).catch(() => undefined);
  if (!info) {
    if (await lstat(path).catch(() => undefined)) throw new MigrationError("brokenLink", path);
    return 0;
  }
  if (!info.isDirectory() || name === keepClosed) return 1;
  const real = await realpath(path).catch(() => path);
  if (ancestors.has(real)) throw new MigrationError("brokenLink", path);
  const inside = new Set([...ancestors, real]);
  let count = 1;
  for (const entry of await readdir(path).catch(() => [] as string[])) count += await archiveEntryCount(root, `${name}/${entry}`, keepClosed, inside);
  return count;
}

export interface MigrationExportRequest {
  readonly categories: readonly MigrationCategory[];
  readonly output: string;
  readonly laisoraSettings: Readonly<Record<string, unknown>>;
}

export interface MigrationExportResult {
  readonly output: string;
  readonly manifest: MigrationManifest;
  readonly mcpKeyServers: readonly string[];
  readonly settingsKeyFiles: readonly string[];
  readonly projects: ProjectsTotals;
}

export async function exportMigration(place: MigrationPlace, request: MigrationExportRequest, report: MigrationProgressReport = () => undefined): Promise<MigrationExportResult> {
  report({ phase: "preparing" });
  const staging = await mkdtemp(join(tmpdir(), "laisora-migration-"));
  try {
    const has = (category: MigrationCategory) => request.categories.includes(category);
    const counts: MigrationCounts = {};
    const put = async (relative: string, data: string | Buffer) => {
      await mkdir(dirname(join(staging, relative)), { recursive: true });
      await writeFile(join(staging, relative), data);
    };
    await mkdir(join(staging, MIGRATION_DIR), { recursive: true });
    if (has("todo") && place.todoStore) {
      const todo = await todoExport(place.todoStore);
      await put(MIGRATION_TODO, todoDocumentJson(todo.document));
      let images = 0;
      for (const name of todo.images) {
        const data = await place.todoStore.readImage(name);
        if (data) { await put(`${MIGRATION_TODO_FILES}/${name}`, data); images++; }
      }
      counts.todo = todo.items;
      counts.todoImages = images;
    }
    if (has("laisoraSettings")) {
      await put(MIGRATION_SETTINGS, `${JSON.stringify(request.laisoraSettings, null, 2)}\n`);
      counts.laisoraSettings = Object.keys(request.laisoraSettings).length;
    }
    const configNames: string[] = [];
    let mcpKeyServers: string[] = [], settingsKeyFiles: string[] = [];
    if (has("claudeEnv")) {
      settingsKeyFiles = await settingsKeyFilesOf(place);
      const entries = await presentClaudeEnv(place);
      configNames.push(...entries);
      counts.claudeEnv = (await treeSize(place.configDir, entries)).files;
      const servers = userMcpServers(await readText(place.globalConfigFile));
      await put(MIGRATION_MCP_SERVERS, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
      counts.mcpServers = Object.keys(servers).length;
      mcpKeyServers = mcpServersWithKeys(servers);
    }
    const projectCategories = request.categories.filter((category): category is ProjectFileCategory => category === "conversations" || category === "memory");
    const exported = projectCategories.length ? (await projectsInventory(place, (done, total) => report({ phase: "preparing", done, total }))).filter(folder => exportedProjectFolder(folder, projectCategories)) : [];
    const folders: MigrationManifestFolder[] = [];
    for (const folder of exported) {
      const cwd = await folderCwdOf(join(place.configDir, PROJECTS_DIR, folder.dirName), folder.dirName);
      folders.push({ dirName: folder.dirName, ...(cwd !== undefined ? { cwd } : {}), sessions: has("conversations") ? folder.sessions : 0, conversationFiles: has("conversations") ? folder.conversationFiles : 0, memoryFiles: has("memory") ? folder.memoryFiles : 0 });
    }
    const projects = projectsTotals(exported, projectCategories);
    if (has("conversations")) counts.conversations = projects.conversations.sessions;
    if (has("memory")) counts.memory = projects.memory.files;
    const archived = projectsArchive(projectCategories, exported);
    const manifest: MigrationManifest = { format: MIGRATION_FORMAT, exportedAt: new Date().toISOString(), home: place.home, configDir: place.configDir,
      categories: request.categories.filter(category => category !== "todo" || place.todoStore !== undefined), counts, folders };
    await put(MIGRATION_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    await put(MIGRATION_README, migrationReadme(manifest));
    const excludeList = archiveExcludeList(place.platform, place.env, archived.memoryExcluded);
    const excludeFile = excludeList ? join(staging, "exclude.txt") : undefined;
    if (excludeFile) await writeFile(excludeFile, excludeList);
    const listFile = archived.names.length ? join(staging, "projects.txt") : undefined;
    if (listFile) await writeFile(listFile, archived.names.map(name => `${name}\n`).join(""));
    const commands = archiveCommands(place.platform, place.env, request.output, [{ dir: place.configDir, names: configNames }, { dir: staging, names: [MIGRATION_README, MIGRATION_DIR] }],
      { ...(excludeFile ? { excludeFile } : {}), ...(listFile ? { listed: { dir: place.configDir, file: listFile } } : {}) });
    const measured = commands.every(command => command.reportsEntries);
    let total = 0, done = 0;
    for (const name of configNames) total += await archiveEntryCount(place.configDir, name);
    for (const name of [MIGRATION_README, MIGRATION_DIR]) total += await archiveEntryCount(staging, name);
    for (const name of archived.names) {
      const dirName = name.split("/")[1];
      total += await archiveEntryCount(place.configDir, name, archived.memoryExcluded.includes(dirName) ? `${name}/${MEMORY_DIR}` : undefined);
    }
    report({ phase: "archiving", ...(measured ? { done, total } : {}) });
    await unlink(request.output).catch(() => undefined);
    try { for (const command of commands) await runArchiver(command, measured ? () => report({ phase: "archiving", done: Math.min(++done, Math.max(total - 1, 0)), total }) : undefined); }
    catch (error) { await unlink(request.output).catch(() => undefined); throw error; }
    if (measured) report({ phase: "archiving", done: total, total });
    return { output: request.output, manifest, mcpKeyServers, settingsKeyFiles, projects };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function previewMigration(place: MigrationPlace, archive: string): Promise<MigrationManifest> {
  const temp = await mkdtemp(join(tmpdir(), "laisora-migration-"));
  try {
    await runArchiver(extractCommand(place.platform, place.env, archive, temp, [MIGRATION_MANIFEST]))
      .catch(error => { throw error instanceof MigrationError && error.code === "archiverMissing" ? error : new MigrationError("notMigration", errorText(error)); });
    const manifest = parseMigrationManifest(await readFile(join(temp, MIGRATION_MANIFEST), "utf8").catch(() => ""));
    if (!manifest) throw new MigrationError("notMigration");
    return manifest;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function moveInto(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try { await retryTransient(() => rename(source, destination)); }
  catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    await retryTransient(() => copyFile(source, destination));
    await rm(source, { force: true });
  }
}

async function appendRelocated(file: string, cwd: string): Promise<void> {
  const lines = await readCwdWindowLines(file).catch(() => undefined);
  if (lines && lastRelocatedCwd(lines).cwd === cwd) return;
  const handle = await open(file, "r");
  let endsWithNewline = true;
  try {
    const size = (await handle.stat()).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      endsWithNewline = last[0] === 0x0a;
    }
  } finally { await handle.close(); }
  await retryTransient(() => appendFile(file, `${endsWithNewline ? "" : "\n"}${relocatedRecord(basename(file, ".jsonl"), cwd)}`));
}

type Placement = { placed: number; kept: number; files: number; filesKept: number; memory: number; memoryKept: number; sessions: string[]; memoryPaths: string[] };
const emptyPlacement = (): Placement => ({ placed: 0, kept: 0, files: 0, filesKept: 0, memory: 0, memoryKept: 0, sessions: [], memoryPaths: [] });

async function placeFile(source: string, destination: string, backup: (existing: string) => Promise<void>, data?: Buffer): Promise<"placed" | "same"> {
  const incoming = data ?? await readFile(source);
  const existing = await readFile(destination).catch(() => undefined);
  const placement = importPlacement(existing, incoming);
  if (placement === "same") return "same";
  if (placement === "backup") await backup(destination);
  if (data) { await mkdir(dirname(destination), { recursive: true }); await retryTransient(() => writeFile(destination, data)); }
  else await moveInto(source, destination);
  return "placed";
}

async function moveConversationFolder(source: string, destination: string, cwd: string | undefined, counted: Placement,
  presentSessionFiles: readonly string[], categories: readonly ProjectFileCategory[]): Promise<Placement> {
  const incoming = categories.includes("conversations") ? await sessionFiles(source) : [];
  const keptSessions = sessionsAlreadyPresent(incoming, presentSessionFiles);
  for await (const segments of walkFiles(source)) {
    const category = projectFileCategory(segments);
    if (!categories.includes(category)) continue;
    const from = join(source, ...segments), target = join(destination, ...segments);
    const session = isSessionFile(segments);
    if (conversationFileKept(segments, keptSessions, existsSync(target))) {
      if (session) counted.kept++; else if (category === "memory") counted.memoryKept++; else counted.filesKept++;
      continue;
    }
    if (session && cwd !== undefined) await appendRelocated(from, cwd);
    await moveInto(from, target);
    if (category === "memory") { counted.memory++; counted.memoryPaths.push(segments.join("/")); continue; }
    if (!session) { counted.files++; continue; }
    counted.placed++;
    counted.sessions.push(segments[0]);
  }
  return counted;
}

export interface MigrationImportResult {
  readonly categories: readonly MigrationCategory[];
  todoItems?: number;
  todoBackup?: string;
  laisoraSettings?: number;
  settingFailures: readonly string[];
  claudeEnvFiles: number;
  backedUp: number;
  backups?: string;
  mcpServers: number;
  mcpSkipped?: string;
  conversations: number;
  conversationsKept: number;
  conversationFiles: number;
  conversationFilesKept: number;
  memoryFiles: number;
  memoryFilesKept: number;
  guide?: string;
  readonly unresolved: Array<{ readonly cwd: string; readonly dirName: string }>;
  error?: { readonly code?: MigrationErrorCode; readonly fsCode?: string; readonly detail: string };
}

export function migrationFailureOf(error: unknown): NonNullable<MigrationImportResult["error"]> {
  if (error instanceof MigrationError) return { code: error.code, detail: error.detail };
  const fsCode = errorCode(error);
  return { ...(fsCode ? { fsCode } : {}), detail: errorText(error) };
}

export async function importMigration(place: MigrationPlace, archive: string, manifest: MigrationManifest,
  writeSettings: (values: Record<string, unknown>) => Promise<readonly string[]>, report: MigrationProgressReport = () => undefined, now: Date = new Date()): Promise<MigrationImportResult> {
  const backupDir = join(place.configDir, "backups", `laisora-import-${now.toISOString().replace(/[:.]/g, "-")}`);
  const result: MigrationImportResult = { categories: manifest.categories, settingFailures: [], claudeEnvFiles: 0, backedUp: 0, mcpServers: 0, conversations: 0, conversationsKept: 0, conversationFiles: 0, conversationFilesKept: 0, memoryFiles: 0, memoryFilesKept: 0, unresolved: [] };
  const backup = async (existing: string, relative: string) => {
    await moveInto(existing, join(backupDir, relative));
    result.backedUp++;
    result.backups = backupDir;
  };
  const remap = <T>(value: T): T => remapJsonPaths(value, manifest.home, place.home) as T;
  let temp: string | undefined;
  try {
    await mkdir(place.configDir, { recursive: true });
    temp = await mkdtemp(join(place.configDir, ".laisora-import-"));
    const extract = extractCommand(place.platform, place.env, archive, temp);
    let extractedFiles = 0;
    report({ phase: "extracting", ...(extract.reportsEntries ? { done: extractedFiles } : {}) });
    await runArchiver(extract, entry => {
      if (!entry.endsWith("/")) report({ phase: "extracting", done: ++extractedFiles });
    });
    report({ phase: "placing" });
    const extracted = temp;
    if (existsSync(join(extracted, MIGRATION_README))) {
      await mkdir(backupDir, { recursive: true });
      await copyFile(join(extracted, MIGRATION_README), join(backupDir, MIGRATION_README));
      result.guide = join(backupDir, MIGRATION_README);
    }
    const has = (category: MigrationCategory) => manifest.categories.includes(category);
    if (has("claudeEnv")) {
      for (const entry of claudeEnvEntries(await readdir(extracted))) {
        const info = await lstat(join(extracted, entry));
        const files = info.isDirectory() ? walkFiles(join(extracted, entry)) : (async function* () { yield [] as readonly string[]; })();
        for await (const inner of files) {
          const segments = [entry, ...inner];
          const source = join(extracted, ...segments), destination = join(place.configDir, ...segments);
          if ((await lstat(source)).isSymbolicLink()) {
            if (!existsSync(destination)) { await moveInto(source, destination); result.claudeEnvFiles++; }
            continue;
          }
          let data: Buffer | undefined;
          if (claudeEnvPathsRemapped(segments)) {
            try {
              const parsed: unknown = JSON.parse(await readFile(source, "utf8"));
              const remapped = remap(parsed);
              if (JSON.stringify(remapped) !== JSON.stringify(parsed)) data = Buffer.from(`${JSON.stringify(remapped, null, 2)}\n`);
            } catch {}
          }
          if (await placeFile(source, destination, existing => backup(existing, segments.join("/")), data) === "placed") result.claudeEnvFiles++;
        }
      }
      const servers = remap(userMcpServers(await readText(join(extracted, MIGRATION_MCP_SERVERS))));
      if (Object.keys(servers).length > 0) {
        const current = await readText(place.globalConfigFile);
        const merged = mergedGlobalConfig(current, servers);
        if (merged === undefined) result.mcpSkipped = `${place.globalConfigFile} could not be read as JSON`;
        else {
          if (merged !== current && current !== undefined) {
            await mkdir(backupDir, { recursive: true });
            await retryTransient(() => writeFile(join(backupDir, basename(place.globalConfigFile)), current));
            result.backedUp++;
            result.backups = backupDir;
          }
          if (merged !== current) {
            const written = `${place.globalConfigFile}.laisora-${process.pid}.tmp`;
            await retryTransient(() => writeFile(written, merged));
            try { await retryTransient(() => rename(written, place.globalConfigFile)); }
            catch (error) { await rm(written, { force: true }).catch(() => undefined); throw error; }
          }
          result.mcpServers = Object.keys(servers).length;
        }
      }
    }
    if (has("laisoraSettings")) {
      const text = await readText(join(extracted, MIGRATION_SETTINGS));
      const values = remap(text === undefined ? {} : JSON.parse(text) as Record<string, unknown>);
      result.laisoraSettings = Object.keys(values).length;
      result.settingFailures = await writeSettings(values);
    }
    if (has("todo") && place.todoStore) {
      const text = await readText(join(extracted, MIGRATION_TODO));
      if (text !== undefined) {
        const document = remapTodoDocument(parseTodoDocument(text), manifest.home, place.home);
        for await (const [name] of walkFiles(join(extracted, MIGRATION_TODO_FILES))) {
          const destination = join(place.todoStore.filesDirectory, name);
          if (!existsSync(destination)) await moveInto(join(extracted, MIGRATION_TODO_FILES, name), destination);
        }
        const previous = await place.todoStore.read();
        if (previous.revision > 0) {
          await mkdir(backupDir, { recursive: true });
          result.todoBackup = join(backupDir, "laisora-todo.json");
          await retryTransient(() => writeFile(result.todoBackup!, todoDocumentJson(previous)));
          result.backups = backupDir;
        }
        const written = await place.todoStore.replace(document);
        result.todoItems = written.items.filter(item => item.deletedAt === undefined).length;
      }
    }
    const projectCategories = manifest.categories.filter((category): category is ProjectFileCategory => category === "conversations" || category === "memory");
    if (projectCategories.length) {
      const projects = join(place.configDir, PROJECTS_DIR);
      const presentByFolder = new Map<string, string[]>();
      for (const dirName of await readdir(projects).catch(() => [] as string[])) presentByFolder.set(dirName, await sessionFiles(join(projects, dirName)));
      const presentSessionFiles = [...presentByFolder.values()].flat();
      for (const folder of manifest.folders) {
        const source = join(extracted, PROJECTS_DIR, folder.dirName);
        if (!existsSync(source)) continue;
        const holder = has("conversations") ? folderHoldingAllSessions(await sessionFiles(source), presentByFolder) : undefined;
        const target = holder === undefined && folder.cwd !== undefined ? conversationTarget({ dirName: folder.dirName, cwd: folder.cwd }, manifest.home, place.home, existsSync) : undefined;
        const counted = emptyPlacement();
        try {
          await moveConversationFolder(source, join(projects, holder ?? target?.dirName ?? folder.dirName), target && target.cwd !== folder.cwd ? target.cwd : undefined, counted, presentSessionFiles, projectCategories);
        } finally {
          result.conversations += counted.placed;
          result.conversationsKept += counted.kept;
          result.conversationFiles += counted.files;
          result.conversationFilesKept += counted.filesKept;
          result.memoryFiles += counted.memory;
          result.memoryFilesKept += counted.memoryKept;
        }
        if (target && !target.found) result.unresolved.push({ cwd: target.cwd, dirName: target.dirName });
      }
    }
  } catch (error) {
    result.error = migrationFailureOf(error);
    if (error instanceof MigrationError && (error.code === "archiverMissing" || error.code === "notMigration") && result.backedUp === 0 && result.conversations === 0) throw error;
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}

async function removeEmptyTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return;
  for (const entry of entries) if (entry.isDirectory()) await removeEmptyTree(join(root, entry.name));
  await rmdir(root).catch(() => undefined);
}

export interface MigrationRebindResult {
  readonly complete: boolean;
  readonly from: string;
  readonly to: string;
  readonly newCwd: string;
  readonly oldCwd?: string;
  readonly conversations: number;
  readonly conversationsKept: number;
  readonly otherFiles: number;
  readonly otherFilesKept: number;
  readonly memoryFiles: number;
  readonly memoryFilesKept: number;
  readonly todoGroups: number;
  readonly todoFailures: readonly string[];
  readonly todoNotChecked?: string;
  readonly verified: number;
  readonly memoryVerified: number;
  readonly unverified: readonly string[];
  readonly error?: string;
}

export async function rebindRefusal(place: MigrationPlace, dirName: string, runningCwd: string | undefined, newCwd: string): Promise<string | undefined> {
  const projects = join(place.configDir, PROJECTS_DIR);
  const source = join(projects, dirName);
  const same = (a: string, b: string) => sameFolderName(a, b, place.platform);
  const present = (await readdir(projects).catch(() => [] as string[])).includes(dirName);
  if (!isProjectDirName(dirName) || !present || !(await stat(source).catch(() => undefined))?.isDirectory()) return `There is no folder ~/.claude/projects/${dirName}; use a dirName exactly as in the import result's unresolved list.`;
  if (runningCwd !== undefined && same(claudeProjectDirName(normalizedWorkFolder(runningCwd, place.platform)), dirName)) return "That folder holds this conversation; it cannot be moved from here.";
  const target = claudeProjectDirName(normalizedWorkFolder(newCwd, place.platform));
  if (target !== dirName && same(target, dirName)) return `The new work folder's place ~/.claude/projects/${target} differs from ~/.claude/projects/${dirName} only in letter case, which this PC treats as the same folder; give the folder path with the same letter case as the old one or move the files by hand.`;
  const cwd = await folderCwdOf(source, dirName);
  if (cwd !== undefined && existsSync(cwd) && same(claudeProjectDirName(normalizedWorkFolder(cwd, place.platform)), dirName)) return `The work folder recorded for that folder, ${cwd}, exists on this PC, so the folder is already in place for it.`;
  return undefined;
}

export async function rebindMigratedFolder(place: MigrationPlace, dirName: string, requestedCwd: string, givenOldCwd?: string): Promise<MigrationRebindResult> {
  const newCwd = normalizedWorkFolder(requestedCwd, place.platform);
  const projects = join(place.configDir, PROJECTS_DIR);
  const source = join(projects, dirName);
  const oldCwd = givenOldCwd !== undefined ? normalizedWorkFolder(givenOldCwd, place.platform) : await folderCwdOf(source, dirName);
  const target = claudeProjectDirName(newCwd);
  const counted = emptyPlacement();
  let failure: string | undefined;
  try {
    if (target === dirName) {
      for (const name of await sessionFiles(source)) {
        await appendRelocated(join(source, name), newCwd);
        counted.placed++;
        counted.sessions.push(name);
      }
    } else {
      const elsewhere: string[] = [];
      for (const other of await readdir(projects).catch(() => [] as string[])) if (other !== dirName && other !== target) elsewhere.push(...await sessionFiles(join(projects, other)));
      await moveConversationFolder(source, join(projects, target), newCwd, counted, elsewhere, ["conversations", "memory"]);
      await removeEmptyTree(source);
    }
  } catch (error) {
    failure = errorText(error);
  }
  let todoGroups = 0;
  const todoFailures: string[] = [];
  const todoNotChecked = !place.todoStore ? "ToDo is not available in this window, so ToDo group bindings were not changed."
    : oldCwd === undefined ? "No conversation record names the old work folder, so ToDo groups bound to it could not be identified; check the ToDo group folders with the user." : undefined;
  if (failure === undefined && oldCwd !== undefined && todoFolderKey(oldCwd) !== todoFolderKey(newCwd) && place.todoStore) {
    const { bindings, tooLong } = relocatedGroupBindings(todoGroupsOf(await place.todoStore.read()), oldCwd, newCwd);
    todoFailures.push(...tooLong);
    for (const binding of bindings) {
      const written = await place.todoStore.apply({ kind: "setGroupBindings", ...binding }, "human");
      if (written.ok) todoGroups++;
      else todoFailures.push(`${binding.group}: ${written.error}`);
    }
  }
  let verified = 0, memoryVerified = 0;
  const unverified: string[] = [];
  for (const name of counted.sessions) {
    const lines = await readCwdWindowLines(join(projects, target, name)).catch(() => undefined);
    const cwd = lines ? lastRelocatedCwd(lines).cwd : undefined;
    if (cwd === newCwd && claudeProjectDirName(cwd) === target) verified++;
    else unverified.push(name);
  }
  for (const relative of counted.memoryPaths) {
    if (existsSync(join(projects, target, ...relative.split("/")))) memoryVerified++;
    else unverified.push(relative);
  }
  return { complete: failure === undefined && unverified.length === 0 && todoFailures.length === 0 && todoNotChecked === undefined,
    from: dirName, to: target, newCwd, ...(oldCwd !== undefined ? { oldCwd } : {}), conversations: counted.placed, conversationsKept: counted.kept, otherFiles: counted.files, otherFilesKept: counted.filesKept,
    memoryFiles: counted.memory, memoryFilesKept: counted.memoryKept, todoGroups, todoFailures, ...(todoNotChecked ? { todoNotChecked } : {}), verified, memoryVerified, unverified,
    ...(failure !== undefined ? { error: `${failure}. What was moved so far is counted above; calling the tool again with the same arguments finishes the move.` } : {}) };
}
