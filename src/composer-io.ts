import { decideOpenMode, DEFAULT_SYSTEM_APP_EXTENSIONS, systemAppExtensions } from "./file-link-open-mode";
import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { lstatSync, readlinkSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";

import { pathIsInside, realPathOrNearestSync } from "./agent-inspector";
import { lexicalPathIsInsideForEarlyRejectOnly, type RealPath } from "./path-containment";
import { ArtifactServer, type ArtifactMime } from "./artifactServer";
import type { Session } from "./extension";
import {
  hasNonDriveColon,
  hasWindowsReservedDeviceName,
  isNetworkOrDevicePath,
  isWindowsDevicePath,
  isWindowsDriveRelativePath,
  isWindowsUncPath,
  parseFileLinkTarget,
  type FileLinkTarget,
} from "./file-link-target";
import { artifactServer, output, setArtifactServer } from "./host-context";
import { configuredDisplayName } from "./claude-settings";
import {
  IMAGE_MAX_BASE64_LEN,
  PICKED_FILE_MAX_COUNT,
  type ImageAttachment,
  type NormalizedEvent,
  type NormalizedEventBody,
  type WebviewToHost,
} from "./protocol";
import { pendingAttachments } from "./pending-attachments";
import { createHydrationDraft, foldHistoryEvents } from "./resume-hydration";
import { isInSessionStore, sessionTranscriptRef } from "./session-files";
import { readSessionHistory } from "./session-transcript";
import type { SessionStore } from "./store-surfaces";
import { recordSeparator } from "./webview/commit-boundary";

function createExportSink(lines: string[], userHeading: string): {
  push: (ev: NormalizedEventBody) => void;
  flush: () => void;
} {
  let assistantBuf = "";
  let recordEnded = false;
  const flush = () => {
    if (assistantBuf.trim()) lines.push("## Assistant", "", assistantBuf.trim(), "");
    assistantBuf = "";
    recordEnded = false;
  };
  const push = (ev: NormalizedEventBody): void => {
    switch (ev.kind) {
      case "user_message":
        flush();
        lines.push(userHeading, "", ev.text, "");
        break;
      case "replayed_message":
        flush();
        lines.push(ev.role === "user" ? userHeading : "## Assistant", "", ev.text, "");
        break;
      case "assistant_text_delta":
        assistantBuf += (recordEnded ? recordSeparator(assistantBuf) : "") + ev.text;
        recordEnded = false;
        break;
      case "assistant_message_uuid":
        recordEnded = true;
        break;
      case "tool_call_started":
        flush();
        lines.push(
          `> ⚙ ${ev.toolName}: \`${(ev.inputSummary ?? ev.inputPreview).slice(0, 200).replace(/`/g, "'")}\``,
          ""
        );
        break;
      case "turn_completed":
      case "turn_interrupted":
      case "turn_failed":
        flush();
        break;
      case "error":
        lines.push(`> ⚠ ${ev.message}`, "");
        break;
      default:
        break;
    }
  };
  return { push, flush };
}

function heldEventsForExport(events: readonly NormalizedEvent[], handoff: boolean): NormalizedEvent[] {
  let replayedFrom: number | undefined;
  for (const ev of events) {
    if (ev.kind !== "replayed_message") continue;
    const at = ev.recordedAt ?? ev.timestamp;
    if (replayedFrom === undefined || at < replayedFrom) replayedFrom = at;
  }
  const isHistoryConversation = (ev: NormalizedEvent): boolean =>
    ev.provenance?.path === "history" &&
    (ev.kind === "user_message" || ev.kind === "assistant_text_delta" || ev.kind === "tool_call_started");
  if (replayedFrom === undefined) {
    return handoff ? events.filter((ev) => !isHistoryConversation(ev)) : [...events];
  }
  const covered = replayedFrom;
  return events.filter((ev) => {
    if (!isHistoryConversation(ev)) return true;
    if (handoff && ev.timestamp < covered) return false;
    return !(ev.timestamp >= covered && ev.kind !== "tool_call_started");
  });
}

async function buildExportMarkdown(s: Session): Promise<string> {
  const dateLocale = String(vscode.env.language ?? "").toLowerCase().startsWith("ja") ? "ja-JP" : "en-US";
  const userHeading = `## ${configuredDisplayName() || "User"}`;
  const lines: string[] = [`# ${s.title}`, "", l10n.t("- Exported: {0}", new Date().toLocaleString(dateLocale)), `- cwd: ${s.cwd}`];
  if (s.handoffSource !== undefined) {
    const source = s.handoffSource.title !== undefined && s.handoffSource.title.length > 0
      ? s.handoffSource.title
      : s.handoffSource.sessionId;
    lines.push(l10n.t("- Continued from: {0}", source));
  }
  const ref = sessionTranscriptRef(s);
  let degraded: string | undefined;
  let history: Awaited<ReturnType<typeof readSessionHistory>> | undefined;
  if (ref === null) {
    degraded = "session-file-not-resolved";
  } else {
    try {
      history = await readSessionHistory(ref.file, isInSessionStore, { generationSessionId: ref.sessionId });
      if (history.readError !== undefined) degraded = history.readError;
      else if (history.events.length === 0) degraded = "empty-record";
    } catch (error) {
      degraded = String(error);
    }
  }
  if (degraded !== undefined || history === undefined) {
    output.appendLine(`[${s.title}] export: falling back to held events (${degraded ?? "empty-record"})`);
    lines.push(l10n.t("- Note: the record could not be read, so only the part held in memory was exported."), "");
    const sink = createExportSink(lines, userHeading);
    for (const ev of heldEventsForExport(s.events, s.handoffSource !== undefined)) sink.push(ev);
    sink.flush();
    return lines.join("\n");
  }
  lines.push("");
  const sink = createExportSink(lines, userHeading);
  const from = history.generationStartAt;
  let recordEnd = 0;
  const tail = {
    turnId: undefined as string | undefined,
    text: "",
    userTexts: new Set<string>(),
    toolUseIds: new Set<string>(),
  };
  const recordNotices = new Set<string>();
  const draft = createHydrationDraft(s);
  await foldHistoryEvents(
    draft,
    history,
    (step) => {
      const ev = step.normalizedEvent;
      if (ev === null) return "continue";
      if (from !== undefined && ev.timestamp < from) return "continue";
      if (ev.timestamp > recordEnd) recordEnd = ev.timestamp;
      if (ev.kind === "error") recordNotices.add(ev.message);
      if (ev.kind === "turn_started") {
        tail.turnId = ev.turnId;
        tail.text = "";
        tail.userTexts.clear();
        tail.toolUseIds.clear();
      } else if ((ev as { turnId?: unknown }).turnId === tail.turnId) {
        if (ev.kind === "assistant_text_delta") tail.text += ev.text;
        else if (ev.kind === "user_message") tail.userTexts.add(ev.text);
        else if (ev.kind === "tool_call_started") tail.toolUseIds.add(ev.toolUseId);
      }
      sink.push(ev);
      return "continue";
    },
    () => false
  );
  const openTurnId = openLiveTurnId(s.events);
  let openTurnText = "";
  for (const ev of s.events) {
    if (ev.provenance?.path !== "live") continue;
    const turnId = (ev as { turnId?: unknown }).turnId;
    if (typeof turnId !== "string") {
      if (ev.kind === "error" && recordNotices.has(ev.message)) continue;
      sink.push(ev);
      continue;
    }
    if (openTurnId === undefined || turnId !== openTurnId) {
      if (ev.timestamp <= recordEnd) continue;
      sink.push(ev);
      continue;
    }
    if (ev.kind === "assistant_text_delta") {
      openTurnText += ev.text;
      if (tail.text.startsWith(openTurnText)) continue;
      sink.push(ev);
      continue;
    }
    if (ev.kind === "user_message" && tail.userTexts.has(ev.text)) continue;
    if (ev.kind === "tool_call_started" && tail.toolUseIds.has(ev.toolUseId)) continue;
    sink.push(ev);
  }
  sink.flush();
  return lines.join("\n");
}

function openLiveTurnId(events: readonly NormalizedEvent[]): string | undefined {
  let open: string | undefined;
  for (const ev of events) {
    if (ev.provenance?.path !== "live") continue;
    if (ev.kind === "turn_started") open = ev.turnId;
    else if (ev.kind === "turn_completed" || ev.kind === "turn_interrupted" || ev.kind === "turn_failed") {
      if (ev.turnId === open) open = undefined;
    }
  }
  return open;
}

let fileCache: { at: number; paths: string[] } | null = null;
async function findWorkspaceFiles(query: string): Promise<string[]> {
  if (!fileCache || Date.now() - fileCache.at > 30_000) {
    const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,dist,.git}/**", 3000);
    fileCache = { at: Date.now(), paths: uris.map((u) => vscode.workspace.asRelativePath(u)) };
  }
  const q = query.toLowerCase();
  return fileCache.paths
    .filter((p) => p.toLowerCase().includes(q))
    .sort((a, b) => a.length - b.length)
    .slice(0, 20);
}

const PICK_IMAGE_MEDIA_TYPES: Record<string, ImageAttachment["mediaType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

async function pickComposerFiles(
  imageSlots: number,
  cwd: string | undefined
): Promise<{ paths: string[]; images: ImageAttachment[] }> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    defaultUri: cwd ? vscode.Uri.file(cwd) : undefined,
  });
  const paths: string[] = [];
  const images: ImageAttachment[] = [];
  for (const uri of uris ?? []) {
    const mediaType = PICK_IMAGE_MEDIA_TYPES[extname(uri.fsPath).toLowerCase()];
    if (mediaType !== undefined && images.length < imageSlots) {
      try {
        const data = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("base64");
        if (data.length <= IMAGE_MAX_BASE64_LEN) {
          images.push({ mediaType, data });
          continue;
        }
      } catch {}
    }
    if (paths.length >= PICKED_FILE_MAX_COUNT) continue;
    paths.push(vscode.workspace.asRelativePath(uri));
  }
  return { paths, images };
}

export function postAttachments(st: SessionStore, tabId: string): void {
  st.post({ type: "attachments", tabId, items: pendingAttachments.infos(tabId) });
}

function normalizeWindowsVolumeCase(value: string): string {
  if (process.platform !== "win32") return value;
  if (/^[A-Za-z]:/.test(value)) return value[0].toUpperCase() + value.slice(1);
  if (isWindowsUncPath(value)) {
    const root = win32.parse(value).root;
    return root.toLowerCase() + value.slice(root.length);
  }
  return value;
}

function hasSymlinkBelowRoot(root: string, target: string): boolean | null {
  let current = root;
  for (const segment of relative(root, target).split(sep).filter((part) => part.length > 0)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      return null;
    }
  }
  return false;
}

const LINK_CHAIN_DEPTH_MAX = 32;

function linkChainReachesNetworkOrDevice(target: string, depth: number): boolean {
  if (depth > LINK_CHAIN_DEPTH_MAX || isNetworkOrDevicePath(target)) return true;
  const absolute = resolve(target);
  if (isNetworkOrDevicePath(absolute)) return true;
  const { root } = parse(absolute);
  let current = root;
  for (const segment of absolute.slice(root.length).split(sep).filter((part) => part.length > 0)) {
    current = join(current, segment);
    try {
      const info = lstatSync(current);
      if (!info.isSymbolicLink()) continue;
      if (linkChainReachesNetworkOrDevice(resolve(dirname(current), readlinkSync(current)), depth + 1)) return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      return true;
    }
  }
  return false;
}

function isWindowsReservedOrStreamPath(value: string): boolean {
  return (
    process.platform === "win32" &&
    (isWindowsDriveRelativePath(value) || hasWindowsReservedDeviceName(value) || hasNonDriveColon(value))
  );
}

export const READ_ONLY_FILE_SCHEME = "laisora-readonly";
const readOnlyApprovals = new Map<string, string>();
const approvalKey = (fsPath: string): string => {
  const normalized = fsPath.normalize("NFC");
  return process.platform === "linux" ? normalized : normalized.toLowerCase();
};

function approvedReadOnlyUri(realPath: string): vscode.Uri {
  readOnlyApprovals.set(approvalKey(realPath), realPath);
  return vscode.Uri.file(realPath).with({ scheme: READ_ONLY_FILE_SCHEME });
}

export function createReadOnlyFileProvider(): vscode.FileSystemProvider {
  const approved = (uri: vscode.Uri): string => {
    const realPath = readOnlyApprovals.get(approvalKey(uri.fsPath));
    if (realPath === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    return realPath;
  };
  const refuse = (uri: vscode.Uri): never => {
    throw vscode.FileSystemError.NoPermissions(uri);
  };
  return {
    onDidChangeFile: () => ({ dispose: () => {} }),
    watch: () => ({ dispose: () => {} }),
    stat: async (uri) => {
      const info = await stat(approved(uri));
      if (!info.isFile()) throw vscode.FileSystemError.FileNotFound(uri);
      return {
        type: vscode.FileType.File,
        ctime: info.ctimeMs,
        mtime: info.mtimeMs,
        size: info.size,
        permissions: vscode.FilePermission.Readonly,
      };
    },
    readFile: async (uri) => readFile(approved(uri)),
    readDirectory: refuse,
    createDirectory: refuse,
    writeFile: refuse,
    delete: refuse,
    rename: refuse,
  };
}

export function registerReadOnlyFileProvider(): vscode.Disposable | undefined {
  return vscode.workspace.registerFileSystemProvider?.(READ_ONLY_FILE_SCHEME, createReadOnlyFileProvider(), {
    isCaseSensitive: process.platform === "linux",
    isReadonly: true,
  });
}

export async function openConversationFile(session: Session, rawTarget: string, fromEditorPanel: boolean): Promise<void> {
  const parsed = parseFileLinkTarget(rawTarget, { windows: process.platform === "win32" });
  if (parsed === null) {
    void vscode.window.showWarningMessage(l10n.t("LAISORA: This file link cannot be opened."));
    return;
  }

  const relativePath =
    parsed.kind === "path" && !isAbsolute(parsed.resource) && !win32.isAbsolute(parsed.resource);
  if ((relativePath && session.cwd.length === 0) || (parsed.kind === "path" && isWindowsReservedOrStreamPath(parsed.resource))) {
    void vscode.window.showWarningMessage(l10n.t("LAISORA: This file link cannot be opened."));
    return;
  }

  let candidate: string;
  try {
    candidate =
      parsed.kind === "file-uri"
        ? vscode.Uri.parse(parsed.resource, true).fsPath
        : relativePath
          ? resolve(session.cwd, parsed.resource)
          : parsed.resource;
  } catch {
    void vscode.window.showWarningMessage(l10n.t("LAISORA: This file link cannot be opened."));
    return;
  }

  const rootCandidates = [
    ...(session.cwd.length === 0 ? [] : [session.cwd]),
    ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  ];
  if (isWindowsDevicePath(candidate) || isWindowsReservedOrStreamPath(candidate)) {
    void vscode.window.showWarningMessage(l10n.t("LAISORA: This file link cannot be opened."));
    return;
  }

  const roots = rootCandidates
    .map((raw) => ({ raw: resolve(raw), real: realPathOrNearestSync(raw) }))
    .filter((root): root is { raw: string; real: RealPath } => root.real !== null);
  const preflightRoot = roots
    .flatMap((root) => [root.raw, root.real])
    .find((root) =>
      lexicalPathIsInsideForEarlyRejectOnly(normalizeWindowsVolumeCase(root), normalizeWindowsVolumeCase(candidate))
    );
  if (preflightRoot === undefined) {
    const config = vscode.workspace.getConfiguration("laisora");
    if (config.get<boolean>("fileLinks.allowOutsideWorkspace", false) !== true) {
      void vscode.window.showWarningMessage(
        l10n.t("LAISORA: The file is outside this workspace and conversation folder.")
      );
      return;
    }
    if (isNetworkOrDevicePath(candidate) || linkChainReachesNetworkOrDevice(candidate, 0)) {
      void vscode.window.showWarningMessage(l10n.t("LAISORA: This file link cannot be opened."));
      return;
    }
    const realOutside = realPathOrNearestSync(candidate);
    if (realOutside === null || isNetworkOrDevicePath(realOutside)) {
      void vscode.window.showWarningMessage(l10n.t("LAISORA: This file link cannot be opened."));
      return;
    }
    const outsideRoots = !roots.some((root) => pathIsInside(root.real, realOutside));
    await openResolvedFile(realOutside, parsed, outsideRoots
      ? {
          confirm: config.get<boolean>("fileLinks.confirmOutsideWorkspace", true) !== false,
          readOnly: config.get<boolean>("fileLinks.openOutsideReadOnly", true) !== false,
        }
      : null, fromEditorPanel, !outsideRoots);
    return;
  }
  if (hasSymlinkBelowRoot(preflightRoot, candidate) !== false) {
    void vscode.window.showWarningMessage(l10n.t("LAISORA: This file link cannot be opened."));
    return;
  }

  const realCandidate = realPathOrNearestSync(candidate);
  if (
    realCandidate === null ||
    !roots.some((root) => pathIsInside(root.real, realCandidate))
  ) {
    void vscode.window.showWarningMessage(
      realCandidate === null
        ? l10n.t("LAISORA: This file link cannot be opened.")
        : l10n.t("LAISORA: The file is outside this workspace and conversation folder.")
    );
    return;
  }
  await openResolvedFile(realCandidate, parsed, null, fromEditorPanel,
    roots.some((root) => pathIsInside(root.real, realCandidate)));
}

async function openResolvedFile(
  realCandidate: string,
  parsed: FileLinkTarget,
  outside: { confirm: boolean; readOnly: boolean } | null,
  fromEditorPanel: boolean,
  inside: boolean
): Promise<void> {
  if (isWindowsReservedOrStreamPath(realCandidate)) {
    void vscode.window.showWarningMessage(l10n.t("LAISORA: This file link cannot be opened."));
    return;
  }
  let info;
  try {
    info = await stat(realCandidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      void vscode.window.showWarningMessage(l10n.t("LAISORA: The file was not found."));
    } else {
      void vscode.window.showWarningMessage(l10n.t("LAISORA: This file link cannot be opened."));
    }
    return;
  }
  const extensions = systemAppExtensions(
    vscode.workspace.getConfiguration("laisora").get("fileLinks.openWithSystemApp", DEFAULT_SYSTEM_APP_EXTENSIONS),
    () => output.appendLine(l10n.t("R-CNV-20: Invalid or blocked extensions in the default app setting were ignored."))
  );
  const mode = decideOpenMode(realCandidate, { isDirectory: info.isDirectory(), inside, systemAppExtensions: extensions });
  if (mode === "refuse" || (!info.isFile() && !info.isDirectory())) {
    void vscode.window.showWarningMessage(l10n.t("LAISORA: The file was not found."));
    return;
  }

  if (mode === "reveal-folder" || mode === "system-app") {
    try {
      const uri = vscode.Uri.file(realCandidate);
      if (mode === "reveal-folder") await vscode.commands.executeCommand("revealFileInOS", uri);
      else if (!await vscode.env.openExternal(uri)) throw new Error("openExternal returned false");
    } catch (error) {
      output.appendLine(`[file-link] R-CNV-20: ${String(error)}`);
      void vscode.window.showWarningMessage(l10n.t("LAISORA: This file link cannot be opened."));
    }
    return;
  }

  if (outside?.confirm) {
    const open = l10n.t("Open");
    const answer = await vscode.window.showWarningMessage(
      l10n.t("This file is outside the workspace. Open it?"),
      { modal: true, detail: realCandidate },
      open
    );
    if (answer !== open) return;
  }

  const uri = outside?.readOnly ? approvedReadOnlyUri(realCandidate) : vscode.Uri.file(realCandidate);
  let document: vscode.TextDocument | undefined;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    output.appendLine(`[file-link] not opened as text, using the default editor: ${String(error)}`);
  }
  try {
    if (document === undefined) {
      await vscode.commands.executeCommand("vscode.open", uri);
    } else if (parsed.line === undefined) {
      await vscode.window.showTextDocument(document);
    } else {
      const line = Math.min(parsed.line - 1, Math.max(0, document.lineCount - 1));
      const column = Math.min((parsed.column ?? 1) - 1, document.lineAt(line).text.length);
      const position = new vscode.Position(line, column);
      await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
    }
  } catch (error) {
    output.appendLine(`[file-link] open failed: ${String(error)}`);
    void vscode.window.showWarningMessage(l10n.t("LAISORA: This file link cannot be opened."));
    return;
  }
  if (outside !== null) return;
  if (!fromEditorPanel) return;
  if (vscode.workspace.getConfiguration("laisora").get<boolean>("fileLinks.revealInExplorer", true) === false) return;

  try {
    await vscode.commands.executeCommand("revealInExplorer", uri);
  } catch {
    void vscode.window.showWarningMessage(
      l10n.t("LAISORA: The file opened, but it could not be shown in Explorer.")
    );
  }
}

export async function handleComposerMessage(
  st: SessionStore,
  msg: Extract<
    WebviewToHost,
    | { type: "queryFiles" | "pickFiles" | "openFile" | "exportTab" | "artifact/preview" | "openThemePicker" }
    | { type: "attachImage" | "removeAttachment" }
  >,
  target: Session | undefined,
  sender: vscode.Webview
): Promise<void> {
  switch (msg.type) {
    case "attachImage": {
      pendingAttachments.attach(msg.tabId, msg.mediaType, msg.data);
      postAttachments(st, msg.tabId);
      break;
    }
    case "removeAttachment": {
      pendingAttachments.remove(msg.tabId, msg.attachmentId);
      postAttachments(st, msg.tabId);
      break;
    }
    case "queryFiles": {
      const paths = await findWorkspaceFiles(msg.query);
      st.post({ type: "files", reqId: msg.reqId, paths });
      break;
    }
    case "pickFiles": {
      const picked = await pickComposerFiles(msg.imageSlots, target?.cwd);
      st.post({ type: "pickedFiles", reqId: msg.reqId, ...picked });
      break;
    }
    case "openFile": {
      await openConversationFile(target!, msg.target, st.panel !== null && st.panel.webview === sender);
      break;
    }
    case "exportTab": {
      const md = await buildExportMarkdown(target!);
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          join(target!.cwd || homedir(), `laisora-${target!.title.replace(/[\\/:*?"<>|]/g, "_")}.md`)
        ),
        filters: { Markdown: ["md"] },
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(md, "utf8"));
        void vscode.window.showInformationMessage(
          l10n.t("LAISORA: Exported the conversation ({0})", uri.fsPath)
        );
      }
      break;
    }
    case "artifact/preview": {
      const server = artifactServer ?? new ArtifactServer();
      setArtifactServer(server);
      const mime: ArtifactMime = msg.lang === "html" ? "text/html" : "image/svg+xml";
      const key =
        msg.artifactId ??
        createHash("sha256").update(msg.lang).update("\0").update(msg.content).digest("hex");
      const url = await server.register(key, msg.content, mime);
      try {
        await vscode.commands.executeCommand("simpleBrowser.show", url);
      } catch (error) {
        output.appendLine(`[artifact] Simple Browserを開けないため外部ブラウザを使用: ${String(error)}`);
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
      break;
    }
    case "openThemePicker":
      await vscode.commands.executeCommand("workbench.action.selectTheme");
      break;
  }
}
