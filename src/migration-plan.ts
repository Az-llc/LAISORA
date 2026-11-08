import { posix, win32 } from "node:path";
import { claudeProjectDirName, normalizeDriveLetter } from "./claude-env";
import { isMigrationCategory, isProjectDirName, type MigrationCategory } from "./migration-categories";
import { todoBindableFolderPath, type TodoDocument, type TodoGroup, type TodoGroupAlias, type TodoGroupFolder } from "./todo-model";

export const CLAUDE_ENV_ENTRIES = ["CLAUDE.md", "rules", "hooks", "skills", "agents", "commands", "output-styles", "plugins", "settings.json", "settings.local.json", "keybindings.json"] as const;
export const MIGRATION_DIR = "laisora-migration";
export const MIGRATION_README = "LAISORA-MIGRATION.md";
export const MIGRATION_MANIFEST = `${MIGRATION_DIR}/manifest.json`;
export const MIGRATION_SETTINGS = `${MIGRATION_DIR}/laisora-settings.json`;
export const MIGRATION_MCP_SERVERS = `${MIGRATION_DIR}/mcp-servers.json`;
export const MIGRATION_TODO = `${MIGRATION_DIR}/todo/todo.json`;
export const MIGRATION_TODO_FILES = `${MIGRATION_DIR}/todo/files`;
export const PROJECTS_DIR = "projects";
export const MEMORY_DIR = "memory";
export const MIGRATION_FORMAT = 1;

export type MigrationCounts = Partial<Record<MigrationCategory | "mcpServers" | "todoImages", number>>;

export interface MigrationManifestFolder {
  readonly dirName: string;
  readonly cwd?: string;
  readonly sessions: number;
  readonly conversationFiles: number;
  readonly memoryFiles: number;
}

export interface MigrationManifest {
  readonly format: typeof MIGRATION_FORMAT;
  readonly exportedAt: string;
  readonly home: string;
  readonly configDir: string;
  readonly categories: readonly MigrationCategory[];
  readonly counts: MigrationCounts;
  readonly folders: readonly MigrationManifestFolder[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function parseMigrationManifest(text: string): MigrationManifest | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(value) || value.format !== MIGRATION_FORMAT || typeof value.exportedAt !== "string" || typeof value.home !== "string" || typeof value.configDir !== "string") return undefined;
  if (!Array.isArray(value.categories) || !value.categories.every(isMigrationCategory)) return undefined;
  if (!isRecord(value.counts) || !Object.values(value.counts).every(isCount)) return undefined;
  if (!Array.isArray(value.folders) || !value.folders.every(folder => isRecord(folder) && typeof folder.dirName === "string" && isProjectDirName(folder.dirName)
    && (folder.cwd === undefined || typeof folder.cwd === "string" && folder.cwd !== "") && isCount(folder.sessions) && isCount(folder.conversationFiles) && isCount(folder.memoryFiles))) return undefined;
  return {
    format: MIGRATION_FORMAT, exportedAt: value.exportedAt, home: value.home, configDir: value.configDir, categories: value.categories,
    counts: value.counts as MigrationCounts,
    folders: (value.folders as MigrationManifestFolder[]).map(({ dirName, cwd, sessions, conversationFiles, memoryFiles }) => ({ dirName, ...(cwd !== undefined ? { cwd } : {}), sessions, conversationFiles, memoryFiles })),
  };
}

export function claudeEnvEntries(present: readonly string[]): string[] {
  return CLAUDE_ENV_ENTRIES.filter(name => present.includes(name));
}

export function claudeEnvPathsRemapped(segments: readonly string[]): boolean {
  if (segments.length === 1) return segments[0] === "settings.json" || segments[0] === "settings.local.json";
  return segments.length === 2 && segments[0] === "plugins" && segments[1].endsWith(".json");
}

export const withoutTrailingSeparators = (path: string) => path.replace(/[\\/]+$/, "");
export const isSessionFileName = (name: string) => name.endsWith(".jsonl");

export type ProjectFileCategory = Extract<MigrationCategory, "conversations" | "memory">;

export function projectFileCategory(segments: readonly string[]): ProjectFileCategory {
  return segments.length > 1 && segments[0] === MEMORY_DIR ? "memory" : "conversations";
}

export interface ProjectFolderInventory {
  readonly dirName: string;
  readonly sessions: number;
  readonly conversationFiles: number;
  readonly conversationBytes: number;
  readonly memoryFiles: number;
  readonly memoryBytes: number;
}

export interface ProjectsTotals {
  readonly conversations: { readonly sessions: number; readonly bytes: number };
  readonly memory: { readonly files: number; readonly bytes: number };
}

export function projectsTotals(folders: readonly ProjectFolderInventory[], categories: readonly MigrationCategory[] = ["conversations", "memory"]): ProjectsTotals {
  const sum = (category: ProjectFileCategory, pick: (folder: ProjectFolderInventory) => number) => categories.includes(category) ? folders.reduce((total, folder) => total + pick(folder), 0) : 0;
  return {
    conversations: { sessions: sum("conversations", folder => folder.sessions), bytes: sum("conversations", folder => folder.conversationBytes) },
    memory: { files: sum("memory", folder => folder.memoryFiles), bytes: sum("memory", folder => folder.memoryBytes) },
  };
}

export function folderHolds(folder: { readonly conversationFiles: number; readonly memoryFiles: number }, category: ProjectFileCategory): boolean {
  return (category === "memory" ? folder.memoryFiles : folder.conversationFiles) > 0;
}

export function exportedProjectFolder(folder: ProjectFolderInventory, categories: readonly MigrationCategory[]): boolean {
  return categories.includes("conversations") && folderHolds(folder, "conversations") || categories.includes("memory") && folderHolds(folder, "memory");
}

const projectMemoryDir = (dirName: string) => `${PROJECTS_DIR}/${dirName}/${MEMORY_DIR}`;

export function projectsArchive(categories: readonly MigrationCategory[], folders: readonly ProjectFolderInventory[]): { names: string[]; memoryExcluded: string[] } {
  const exported = folders.filter(folder => exportedProjectFolder(folder, categories));
  if (categories.includes("conversations")) {
    return { names: exported.map(folder => `${PROJECTS_DIR}/${folder.dirName}`), memoryExcluded: categories.includes("memory") ? [] : exported.filter(folder => folderHolds(folder, "memory")).map(folder => folder.dirName) };
  }
  return { names: exported.map(folder => projectMemoryDir(folder.dirName)), memoryExcluded: [] };
}

export function archiveExcludeList(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, memoryExcluded: readonly string[]): string {
  const anchor = bsdtarPath(platform, env) === undefined ? "" : "^";
  return memoryExcluded.filter(isProjectDirName).map(dirName => `${anchor}${projectMemoryDir(dirName)}/?*\n`).join("");
}

const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path);

const WINDOWS_DEVICE_PREFIX = /^[\\/]{2}[?.][\\/]/;

export function normalizedWorkFolder(path: string, platform: NodeJS.Platform = process.platform): string {
  const plain = WINDOWS_DEVICE_PREFIX.test(path) ? path.slice(4).replace(/^UNC[\\/]/i, "\\\\") : path;
  const windows = isWindowsPath(plain) || platform === "win32" && /^[\\/]/.test(plain);
  const trimmed = withoutTrailingSeparators((windows ? win32 : posix).resolve(plain));
  if (/^[A-Za-z]:$/.test(trimmed)) return `${normalizeDriveLetter(trimmed)}\\`;
  return trimmed === "" ? "/" : normalizeDriveLetter(trimmed);
}

export function sameFolderName(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

type HomeForm = { readonly text: string; readonly render: (to: string) => string; readonly separator: "\\" | "/" };

function homeForms(home: string): HomeForm[] {
  const trimmed = withoutTrailingSeparators(home);
  if (!isWindowsPath(trimmed)) return [{ text: trimmed, render: to => to, separator: "/" }];
  const slashed = trimmed.replace(/\\/g, "/");
  const toSlashed = (to: string) => to.replace(/\\/g, "/");
  return [
    { text: trimmed.replace(/\//g, "\\"), render: to => to, separator: "\\" },
    { text: slashed, render: toSlashed, separator: "/" },
    { text: `/${slashed[0].toLowerCase()}${slashed.slice(2)}`, render: to => isWindowsPath(to) ? `/${to[0].toLowerCase()}${toSlashed(to).slice(2)}` : to, separator: "/" },
  ];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function remapHomeInText(text: string, from: string, to: string): string {
  const target = withoutTrailingSeparators(to);
  let result = text;
  for (const form of homeForms(from)) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(form.text)}(?![A-Za-z0-9_.-])`, isWindowsPath(from) ? "gi" : "g");
    result = result.replace(pattern, () => form.render(target));
  }
  return result;
}

export function remapJsonPaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return remapHomeInText(value, from, to);
  if (Array.isArray(value)) return value.map(entry => remapJsonPaths(entry, from, to));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remapJsonPaths(entry, from, to)]));
  return value;
}

export function remapPath(path: string, from: string, to: string): string | undefined {
  const target = withoutTrailingSeparators(to);
  const windows = isWindowsPath(from);
  for (const form of homeForms(from)) {
    const head = path.slice(0, form.text.length);
    const same = windows ? head.toLowerCase() === form.text.toLowerCase() : head === form.text;
    const rest = path.slice(form.text.length);
    if (!same || (rest !== "" && rest[0] !== "\\" && rest[0] !== "/")) continue;
    const rendered = form.render(target);
    const separator = isWindowsPath(rendered) && !rendered.includes("/") ? win32.sep : posix.sep;
    return rendered + rest.replace(/[\\/]/g, separator);
  }
  return undefined;
}

export function remapTodoDocument(document: TodoDocument, from: string, to: string): TodoDocument {
  const groups = document.groups ? remapTodoGroups(document.groups, from, to) : undefined;
  const unbound = document.unboundFolders?.map(folder => remapPath(folder, from, to) ?? folder);
  return { ...document, ...(groups ? { groups } : {}), ...(unbound ? { unboundFolders: unbound } : {}) };
}

export function remapTodoGroups(groups: readonly TodoGroup[], from: string, to: string): TodoGroup[] {
  return groups.map(group => group.folders?.length
    ? { ...group, folders: group.folders.map(folder => ({ ...folder, path: remapPath(folder.path, from, to) ?? folder.path })) }
    : group);
}

export function folderCwd(dirName: string, relocated: string | undefined, cwds: readonly string[]): string | undefined {
  return relocated ?? cwds.find(cwd => claudeProjectDirName(cwd) === dirName) ?? cwds[0];
}

export type GroupBindings = { readonly group: string; readonly folders: readonly TodoGroupFolder[]; readonly aliases: readonly TodoGroupAlias[] };

export function relocatedGroupBindings(groups: readonly TodoGroup[], from: string, to: string): { bindings: GroupBindings[]; tooLong: string[] } {
  const bindings: GroupBindings[] = [], tooLong: string[] = [];
  for (const group of groups) {
    let changed = false;
    const folders = (group.folders ?? []).map(folder => {
      const moved = remapPath(folder.path, from, to);
      if (moved === undefined || moved === folder.path) return folder;
      const path = todoBindableFolderPath(moved);
      if (path === undefined) { tooLong.push(`${group.name}: ${moved}`); return folder; }
      changed = true;
      return { ...folder, path };
    });
    if (changed) bindings.push({ group: group.name, folders, aliases: group.aliases ?? [] });
  }
  return { bindings, tooLong };
}

export interface ConversationTarget {
  readonly dirName: string;
  readonly cwd: string;
  readonly found: boolean;
}

export function conversationTarget(folder: { readonly dirName: string; readonly cwd: string }, from: string, to: string, exists: (path: string) => boolean): ConversationTarget {
  const cwd = remapPath(folder.cwd, from, to) ?? folder.cwd;
  return exists(cwd) ? { dirName: claudeProjectDirName(cwd), cwd, found: true } : { dirName: folder.dirName, cwd, found: false };
}

const sessionIdOf = (name: string) => name.slice(0, -".jsonl".length);

export function conversationFileKept(segments: readonly string[], keptSessions: ReadonlySet<string>, targetExists: boolean): boolean {
  if (targetExists) return true;
  if (segments.length > 1) return keptSessions.has(segments[0]);
  return isSessionFileName(segments[0]) && keptSessions.has(sessionIdOf(segments[0]));
}

export function folderHoldingAllSessions(incomingFiles: readonly string[], presentByFolder: ReadonlyMap<string, readonly string[]>): string | undefined {
  const incoming = incomingFiles.filter(isSessionFileName);
  if (incoming.length === 0) return undefined;
  for (const [dirName, files] of presentByFolder) if (incoming.every(name => files.includes(name))) return dirName;
  return undefined;
}

export function sessionsAlreadyPresent(incomingFiles: readonly string[], presentFiles: readonly string[]): Set<string> {
  const present = new Set(presentFiles.filter(isSessionFileName).map(sessionIdOf));
  return new Set(incomingFiles.filter(isSessionFileName).map(sessionIdOf).filter(id => present.has(id)));
}

export function relocatedRecord(sessionId: string, cwd: string): string {
  return `${JSON.stringify({ type: "relocated", sessionId, relocatedCwd: cwd })}\n`;
}

export type ImportPlacement = "write" | "same" | "backup";

export function importPlacement(existing: Uint8Array | undefined, incoming: Uint8Array): ImportPlacement {
  if (existing === undefined) return "write";
  return Buffer.compare(Buffer.from(existing), Buffer.from(incoming)) === 0 ? "same" : "backup";
}

export function userMcpServers(globalConfigText: string | undefined): Record<string, unknown> {
  if (globalConfigText === undefined) return {};
  try {
    const value = JSON.parse(globalConfigText) as unknown;
    return isRecord(value) && isRecord(value.mcpServers) ? value.mcpServers : {};
  } catch { return {}; }
}

const SECRET_NAME = /(key|token|secret|pass|pwd|credential|auth|bearer|cookie|session|header|webhook|dsn|private)/i;
const TOKEN_PREFIX = /(^|[^A-Za-z0-9])(sk-|sk_live_|sk_test_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abpr]-|xapp-|AKIA|AIza|hf_|npm_|ya29\.)/;
const SECRET_IN_VALUE = /\b(bearer|basic)\s+\S|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@|hooks\.slack\.com\/services\//i;

export function secretLikeValue(text: string): boolean {
  const compact = text.trim();
  return TOKEN_PREFIX.test(compact) || SECRET_IN_VALUE.test(compact)
    || /^[A-Za-z0-9_\-+=.]{32,}$/.test(compact) && /[0-9]/.test(compact) && /[A-Za-z]/.test(compact);
}

export function secretLikeEntries(record: unknown): string[] {
  if (!isRecord(record)) return [];
  return Object.entries(record).filter(([name, value]) => typeof value === "string" && value !== ""
    && (SECRET_NAME.test(name) && !(COUNT_NAME.test(name) && PLAIN_SETTING_VALUE.test(value.trim())) || secretLikeValue(value))).map(([name]) => name);
}

const PLAIN_SETTING_VALUE = /^(-?\d+(\.\d+)?|true|false|yes|no|on|off)$/i;
const COUNT_NAME = /(_TOKENS$|^MAX_|_LIMIT$|_TIMEOUT$|_MS$)/i;

const filledEntries = (record: unknown): string[] => isRecord(record) ? Object.entries(record).filter(([, value]) => value !== "" && value !== null && value !== undefined).map(([name]) => name) : [];

export function mcpServersWithKeys(servers: Record<string, unknown>): string[] {
  const listed = (value: unknown) => (typeof value === "string" ? [value] : Array.isArray(value) ? value : [])
    .some(entry => typeof entry === "string" && (SECRET_NAME.test(entry) || secretLikeValue(entry)));
  return Object.entries(servers).filter(([, server]) => isRecord(server)
    && (secretLikeEntries(server.env).length > 0 || filledEntries(server.headers).length > 0 || listed(server.args) || listed(server.url)))
    .map(([name]) => name);
}

export function claudeSettingsKeyFields(text: string | undefined): string[] {
  if (text === undefined) return [];
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value)) return [];
    return [...secretLikeEntries(value.env).map(name => `env.${name}`), ...(typeof value.apiKeyHelper === "string" && value.apiKeyHelper !== "" ? ["apiKeyHelper"] : [])];
  } catch { return []; }
}

export function mergedGlobalConfig(globalConfigText: string | undefined, servers: Record<string, unknown>): string | undefined {
  let current: Record<string, unknown> = {};
  if (globalConfigText !== undefined) {
    try {
      const value = JSON.parse(globalConfigText) as unknown;
      if (!isRecord(value)) return undefined;
      current = value;
    } catch { return undefined; }
  }
  const existing = isRecord(current.mcpServers) ? current.mcpServers : {};
  return `${JSON.stringify({ ...current, mcpServers: { ...existing, ...servers } }, null, 2)}\n`;
}

export type ArchiverCommand = { readonly command: string; readonly args: readonly string[]; readonly cwd?: string; readonly stdinFile?: string; readonly reportsEntries?: true };
export type ArchiveRoot = { readonly dir: string; readonly names: readonly string[] };
export type ArchiveOptions = { readonly excludeFile?: string; readonly listed?: { readonly dir: string; readonly file: string } };

function bsdtarPath(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (platform === "win32") return win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "tar.exe");
  return platform === "darwin" ? "/usr/bin/tar" : undefined;
}

export function archiveCommands(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, output: string, roots: readonly ArchiveRoot[], { excludeFile, listed }: ArchiveOptions = {}): ArchiverCommand[] {
  const used = roots.filter(root => root.names.length > 0);
  const tar = bsdtarPath(platform, env);
  if (tar === undefined) {
    const exclude = excludeFile ? [`-x@${excludeFile}`] : [];
    return [...(listed ? [{ command: "zip", args: ["-r", "-q", output, "-@", ...exclude], cwd: listed.dir, stdinFile: listed.file }] : []),
      ...used.map(root => ({ command: "zip", args: ["-r", "-q", output, ...root.names, ...exclude], cwd: root.dir }))];
  }
  const args = ["-v", ...(excludeFile ? ["-X", excludeFile] : []), "--format", "zip", "--options", "zip:hdrcharset=UTF-8", "-cf", output,
    ...(listed ? ["-C", listed.dir, "-T", listed.file, "--"] : []), ...used.flatMap(root => ["-C", root.dir, ...root.names])];
  return [{ command: tar, args, reportsEntries: true }];
}

export function extractCommand(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, archive: string, destination: string, members: readonly string[] = []): ArchiverCommand {
  const tar = bsdtarPath(platform, env);
  return tar === undefined
    ? { command: "unzip", args: ["-q", "-o", archive, ...members, "-d", destination] }
    : { command: tar, args: ["-v", "-xf", archive, "-C", destination, ...members], reportsEntries: true };
}

export function migrationReadme(manifest: MigrationManifest): string {
  const folders = manifest.folders.length
    ? manifest.folders.map(folder => `| ${folder.cwd !== undefined ? `\`${folder.cwd}\`` : "(unknown: no conversation record names it)"} | \`${PROJECTS_DIR}/${folder.dirName}\` | ${folder.sessions} | ${folder.memoryFiles} |`).join("\n")
    : "(none)";
  return [
    "# LAISORA migration archive",
    "",
    "Read by Claude on the new PC. The archive was written by LAISORA's Migration settings tab or its export tool.",
    "",
    `- Exported at: ${manifest.exportedAt}`,
    `- Home folder on the exporting PC: \`${manifest.home}\``,
    `- Claude config folder on the exporting PC: \`${manifest.configDir}\``,
    `- Categories: ${manifest.categories.join(", ")}`,
    "",
    "## Layout",
    "",
    "- The archive root mirrors the Claude config folder (`~/.claude`): CLAUDE.md, rules, hooks, skills, agents, commands, output-styles, plugins, settings.json, settings.local.json, keybindings.json and `projects/<folder>`: conversation records `*.jsonl` and per-session folders when the conversations category is in the archive, `memory/` when the memory category is.",
    `- \`${MIGRATION_DIR}/\` holds LAISORA's own data: \`manifest.json\`, \`laisora-settings.json\` (user-scope \`laisora.*\` values except the per-PC ones such as the Claude Code executable path), \`mcp-servers.json\` (the \`mcpServers\` of \`~/.claude.json\`; env and headers may hold keys), \`todo/todo.json\` and \`todo/files/\` (ToDo images).`,
    "",
    "## Work folders",
    "",
    "| Work folder on the exporting PC | Folder in the archive | Conversations | Memory files |",
    "|---|---|---|---|",
    folders,
    "",
    "## What the import does and what it leaves to you",
    "",
    "LAISORA's import tool (the Migration settings tab starts a conversation that uses it) copies this guide to `~/.claude/backups/laisora-import-<time>/` and replaces the exporting home folder with this PC's home folder in settings.json, settings.local.json, plugins/*.json, the MCP servers, LAISORA's settings, the ToDo folder bindings and each work folder above, places each work folder's conversations and memory under `~/.claude/projects/<encoded work folder>` with a `relocated` line naming the new work folder (a folder whose work folder is unknown keeps its folder name), and never replaces a file already under `~/.claude/projects/`. Any other existing Claude file whose content differs, `~/.claude.json` when MCP servers are added to it, and the previous ToDo (`laisora-todo.json`) are saved to `~/.claude/backups/laisora-import-<time>/` first.",
    "",
    "Existing files under `~/.claude/projects/` are never replaced: a conversation whose record is already there keeps everything of that session, and existing memory files are kept as they were. To merge the archive's memory into a kept memory file, compare `projects/<folder>/memory/` in the archive with the file on this PC.",
    "",
    "To finish after the import:",
    "",
    "1. Work folders not found on this PC (the `unresolved` list of LAISORA's import result, each with its `dirName` and the expected work folder `cwd`, which is the exporting path with the exporting home folder replaced by this PC's home folder). Their records and memory are under `~/.claude/projects/<dirName>`. For each one, ask the user where the project is on this PC now (clone or copy it first if needed; the user may say it is not needed), then call LAISORA's `rebind_migrated_folder` tool with that `dirName`, its `cwd` as `oldCwd` and the folder as `newCwd`; if it reports a failure partway, call it again with the same arguments. The tool moves the records and memory to the place Claude Code reads for that folder without overwriting anything, adds the new work folder to each moved record, changes LAISORA ToDo groups bound to the old folder, and reports whether each moved conversation now belongs to the new folder. Do not move or edit these files by hand.",
    "   A row whose work folder is unknown has no conversation record naming a folder; its memory stays under its archive folder name; if the user says where it belongs, call `rebind_migrated_folder` with that folder name as `dirName`.",
    "2. Paths outside the home folder (other drives, `/opt`, network shares) are not replaced, and neither are paths inside hook scripts, skills, rules or CLAUDE.md. Search those for the old paths and fix them.",
    "3. Moving between Windows and macOS/Linux: the home folder is replaced but the separators (`\\` and `/`) after it inside settings values, hook commands and MCP server values stay as they were, and Windows-only commands stay; fix them for this OS.",
    "4. MCP servers: commands and env values that point at programs installed on the old PC need those programs on this PC. Keys in env or headers came along as written; replace them if they were PC-specific.",
    "5. Log in to Claude Code again on this PC; login credentials are not in the archive.",
    "",
  ].join("\n");
}
