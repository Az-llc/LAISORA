import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { lstatSync, readlinkSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";

import { pathIsInside, realPathOrNearestSync } from "./agent-inspector";
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
import {
  IMAGE_MAX_BASE64_LEN,
  PICKED_FILE_MAX_COUNT,
  type ImageAttachment,
  type WebviewToHost,
} from "./protocol";
import { pendingAttachments } from "./pending-attachments";
import type { SessionStore } from "./store-surfaces";

// 会話ログのMarkdown書き出し（/export相当）。assistantのストリーミングdeltaはターン単位に結合する
function buildExportMarkdown(s: Session): string {
  const dateLocale = String(vscode.env.language ?? "").toLowerCase().startsWith("ja") ? "ja-JP" : "en-US";
  const lines: string[] = [`# ${s.title}`, "", l10n.t("- Exported: {0}", new Date().toLocaleString(dateLocale)), `- cwd: ${s.cwd}`, ""];
  let assistantBuf = "";
  const flush = () => {
    if (assistantBuf.trim()) {
      lines.push("## Assistant", "", assistantBuf.trim(), "");
    }
    assistantBuf = "";
  };
  for (const ev of s.events) {
    switch (ev.kind) {
      case "user_message":
        flush();
        lines.push("## User", "", ev.text, "");
        break;
      case "replayed_message":
        flush();
        lines.push(`## ${l10n.t("{0} (restored)", ev.role === "user" ? "User" : "Assistant")}`, "", ev.text, "");
        break;
      case "assistant_text_delta":
        assistantBuf += ev.text;
        break;
      case "tool_call_started":
        flush();
        // 要約があればそちらを使う（inputPreview は500字切り詰めで壊れたJSONのことがある）
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
  }
  flush();
  return lines.join("\n");
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

// ＋ボタンの入口。ダイアログは1つで、選ばれたものが画像なら添付・それ以外はパスを返す
// （動作は結果で決まるので利用者に選ばせない）。
// 画像として返せなかったもの（枠切れ・読み取り失敗・サイズ超過）はパスへ落とす（R-CNV-05）
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
    // protocol の pickedFiles 検査は paths.length > PICKED_FILE_MAX_COUNT のメッセージを
    // 丸ごと不正として捨てる。ここで切り捨てないと 1 件も入力欄へ入らない（R-CNV-05）。
    // break にしないのは、以降に画像があって枠が空いていれば添付は続けるため
    if (paths.length >= PICKED_FILE_MAX_COUNT) continue;
    paths.push(vscode.workspace.asRelativePath(uri));
  }
  return { paths, images };
}

// 添付欄の全量を配信する。attachImage / removeAttachment / 送信の確定 / webview の再構築が
// すべてこの 1 本を通る（差分配信にすると経路ごとに webview の手持ちがずれる）
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

// Walks the path one component at a time with lstat/readlink (neither follows the link being inspected), so every link
// target is checked before any later I/O traverses it. Unverifiable components count as dangerous.
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

// R-CNV-12: reserved device names block on device I/O, name:stream opens an NTFS alternate data stream, and C:foo
// depends on the per-drive current directory. POSIX file names may legally contain these.
function isWindowsReservedOrStreamPath(value: string): boolean {
  return (
    process.platform === "win32" &&
    (isWindowsDriveRelativePath(value) || hasWindowsReservedDeviceName(value) || hasNonDriveColon(value))
  );
}

export const READ_ONLY_FILE_SCHEME = "laisora-readonly";
const readOnlyApprovals = new Map<string, string>();
// macOS may hand back the same name in NFD while the approved real path is NFC.
const approvalKey = (fsPath: string): string => {
  const normalized = fsPath.normalize("NFC");
  return process.platform === "linux" ? normalized : normalized.toLowerCase();
};

function approvedReadOnlyUri(realPath: string): vscode.Uri {
  readOnlyApprovals.set(approvalKey(realPath), realPath);
  return vscode.Uri.file(realPath).with({ scheme: READ_ONLY_FILE_SCHEME });
}

// Serves only real paths the Host approved in openConversationFile; reads the disk at request time and refuses every write.
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
  // ?. because the fake vscode of the verification harnesses has no registerFileSystemProvider.
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
  // resolve() would turn a drive-relative C:foo into an absolute path, so the path form is checked before resolving too.
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

  // R-CNV-12: reject device paths and paths outside a lexical allowed root before candidate I/O.
  const rootCandidates = [
    ...(session.cwd.length === 0 ? [] : [session.cwd]),
    ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  ];
  if (isWindowsDevicePath(candidate) || isWindowsReservedOrStreamPath(candidate)) {
    void vscode.window.showWarningMessage(l10n.t("LAISORA: This file link cannot be opened."));
    return;
  }

  // R-CNV-12: roots are trusted inputs, but candidate paths are not. Resolve roots first and reject
  // candidate symlinks before realpath can follow a reparse point to an unapproved UNC share.
  const roots = rootCandidates
    .map((raw) => ({ raw: resolve(raw), real: realPathOrNearestSync(raw) }))
    .filter((root): root is { raw: string; real: string } => root.real !== null);
  const preflightRoot = roots
    .flatMap((root) => [root.raw, root.real])
    .find((root) =>
      pathIsInside(normalizeWindowsVolumeCase(root), normalizeWindowsVolumeCase(candidate))
    );
  if (preflightRoot === undefined) {
    const config = vscode.workspace.getConfiguration("laisora");
    if (config.get<boolean>("fileLinks.allowOutsideWorkspace", false) !== true) {
      void vscode.window.showWarningMessage(
        l10n.t("LAISORA: The file is outside this workspace and conversation folder.")
      );
      return;
    }
    // R-CNV-12: outside the roots, a UNC share or device is refused whatever the settings; realpath must not follow a
    // link into one, and the real path must not be one. Inside a root a UNC candidate stays allowed (UNC workspaces).
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
      : null, fromEditorPanel);
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
  await openResolvedFile(realCandidate, parsed, null, fromEditorPanel);
}

async function openResolvedFile(
  realCandidate: string,
  parsed: FileLinkTarget,
  outside: { confirm: boolean; readOnly: boolean } | null,
  fromEditorPanel: boolean
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
  if (!info.isFile()) {
    void vscode.window.showWarningMessage(l10n.t("LAISORA: The file was not found."));
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

  // R-CNV-12: an outside file opened read-only is served through the read-only provider, never as a writable file: URI.
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
  // R-CNV-12: in the side bar the Explorer replaces the LAISORA view and the conversation disappears.
  if (!fromEditorPanel) return;
  if (vscode.workspace.getConfiguration("laisora").get<boolean>("fileLinks.revealInExplorer", true) === false) return;

  try {
    // Pass the opened URI: after vscode.open a custom or image editor may not be the active editor yet.
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
      // 受理・拒否のどちらでも全量を返す。返さないと webview の添付欄が要求したまま固まる
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
      const md = buildExportMarkdown(target!);
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
      // LAISORA は VS Code 拡張なので、配色は VS Code のテーマ側で決めるのが筋
      // （本体の /color は独自のセッション色で、拡張の見た目とは無関係だった）
      await vscode.commands.executeCommand("workbench.action.selectTheme");
      break;
  }
}
