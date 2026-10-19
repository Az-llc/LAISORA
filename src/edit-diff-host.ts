import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { Session } from "./extension";
import { output } from "./host-context";
import { reconstructEditDiff, singleToolUseResult } from "./edit-summary";
import { basenameOf } from "./path-redaction";
import { isInSessionStore, sessionTranscriptRef } from "./session-files";
import type { WebviewToHost } from "./protocol";

const EDIT_DIFF_SCHEME = "laisora-edit-diff";
const editDiffContents = new Map<string, string>();

export function registerEditDiffProvider(): vscode.Disposable | undefined {
  const provider = vscode.workspace.registerTextDocumentContentProvider?.(EDIT_DIFF_SCHEME, {
    provideTextDocumentContent: (uri) => editDiffContents.get(uri.path)
      ?? l10n.t("LAISORA: This comparison is no longer available. Open it again from the conversation."),
  });
  if (!provider) return undefined;
  const closed = vscode.workspace.onDidCloseTextDocument?.((doc) => {
    if (doc.uri.scheme === EDIT_DIFF_SCHEME) editDiffContents.delete(doc.uri.path);
  });
  return {
    dispose: () => {
      provider.dispose();
      closed?.dispose();
      editDiffContents.clear();
    },
  };
}

async function toolUseResultsOf(file: string, ids: ReadonlySet<string>): Promise<Map<string, unknown>> {
  const found = new Map<string, unknown>();
  const text = await readFile(file, "utf8");
  for (const line of text.split("\n")) {
    if (found.size === ids.size) break;
    if (![...ids].some((id) => !found.has(id) && line.includes(id))) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type !== "user" || record.isSidechain === true) continue;
    const content = (record.message as { content?: unknown } | undefined)?.content;
    const result = singleToolUseResult(content, record.toolUseResult);
    if (result === undefined || !Array.isArray(content)) continue;
    for (const block of content) {
      const id = (block as { type?: unknown; tool_use_id?: unknown } | null)?.tool_use_id;
      if ((block as { type?: unknown } | null)?.type === "tool_result" && typeof id === "string" && ids.has(id) && !found.has(id)) {
        found.set(id, result);
      }
    }
  }
  return found;
}

export async function openEditDiff(
  session: Session,
  msg: Extract<WebviewToHost, { type: "openEditDiff" }>
): Promise<void> {
  const unavailable = (): void => {
    void vscode.window.showInformationMessage(l10n.t("LAISORA: The changes to this file could not be read from the conversation record."));
  };
  try {
    const ref = sessionTranscriptRef(session);
    if (ref === null || !isInSessionStore(ref.file)) return unavailable();
    const results = await toolUseResultsOf(ref.file, new Set([msg.firstToolUseId, msg.lastToolUseId]));
    const first = results.get(msg.firstToolUseId);
    const last = results.get(msg.lastToolUseId);
    const diff = first !== undefined && last !== undefined ? reconstructEditDiff(first, last) : undefined;
    const filePath = (first as { filePath?: unknown } | undefined)?.filePath;
    if (diff === undefined || typeof filePath !== "string") return unavailable();
    const name = basenameOf(filePath);
    const id = randomUUID();
    const before = vscode.Uri.from({ scheme: EDIT_DIFF_SCHEME, path: `/${id}/before/${name}` });
    const after = vscode.Uri.from({ scheme: EDIT_DIFF_SCHEME, path: `/${id}/after/${name}` });
    editDiffContents.set(before.path, diff.before);
    editDiffContents.set(after.path, diff.after);
    try {
      await vscode.commands.executeCommand("vscode.diff", before, after, l10n.t("{0} (before ↔ after)", name));
    } catch (error) {
      editDiffContents.delete(before.path);
      editDiffContents.delete(after.path);
      throw error;
    }
  } catch (error) {
    output.appendLine(`[edit-diff] ${String(error)}`);
    unavailable();
  }
}
