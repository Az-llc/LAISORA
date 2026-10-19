import * as l10n from "@vscode/l10n";
import type { FileEdit } from "../protocol";
import { summaryCardShell, summaryFold, summaryStat } from "./summary-card";

export interface TurnFileEdit {
  toolUseId: string;
  fileEdit: FileEdit;
}

export interface EditSummaryFile extends FileEdit {
  firstToolUseId: string;
  lastToolUseId: string;
}

export interface EditSummary {
  files: EditSummaryFile[];
  added: number;
  removed: number;
}

export const EDIT_SUMMARY_COLLAPSED_ROWS = 3;

export function aggregateTurnEdits(edits: readonly TurnFileEdit[]): EditSummary {
  const byFile = new Map<string, EditSummaryFile>();
  let added = 0;
  let removed = 0;
  for (const { toolUseId, fileEdit } of edits) {
    added += fileEdit.added;
    removed += fileEdit.removed;
    const entry = byFile.get(fileEdit.key);
    if (entry === undefined) {
      byFile.set(fileEdit.key, { ...fileEdit, firstToolUseId: toolUseId, lastToolUseId: toolUseId });
      continue;
    }
    entry.added += fileEdit.added;
    entry.removed += fileEdit.removed;
    entry.lastToolUseId = toolUseId;
  }
  return { files: [...byFile.values()], added, removed };
}

function splitDisplayPath(file: string): { name: string; dir: string } {
  const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return cut < 0 ? { name: file, dir: "" } : { name: file.slice(cut + 1), dir: file.slice(0, cut) };
}

function buildStat(added: number, removed: number): HTMLElement {
  return summaryStat([{ text: `+${added}`, tone: "added" }, { text: `−${removed}`, tone: "removed" }]);
}

function editedFilesText(count: number): string {
  return count === 1 ? l10n.t("1 file edited") : l10n.t("{0} files edited", count);
}

export function buildEditSummaryCard(summary: EditSummary, open: (file: EditSummaryFile) => void): HTMLElement {
  const card = document.createElement("section");
  const { list } = summaryCardShell(card, editedFilesText(summary.files.length), buildStat(summary.added, summary.removed));
  list.classList.add("edit-summary-files");
  const overflow: HTMLElement[] = [];
  summary.files.forEach((file, index) => {
    const item = document.createElement("li");
    const row = document.createElement("button");
    row.type = "button";
    row.className = "edit-summary-row";
    row.title = file.file;
    row.setAttribute("aria-label", l10n.t("Open the changes to {0}", file.file));
    const { name, dir } = splitDisplayPath(file.file);
    const fileEl = document.createElement("span");
    fileEl.className = "edit-summary-file";
    const nameEl = document.createElement("span");
    nameEl.className = "edit-summary-name";
    nameEl.textContent = name;
    fileEl.appendChild(nameEl);
    if (file.created) {
      const created = document.createElement("span");
      created.className = "edit-summary-created";
      created.textContent = l10n.t({ message: "New", comment: ["Marks a file created in this turn"] });
      fileEl.appendChild(created);
    }
    row.appendChild(fileEl);
    if (dir.length > 0) {
      const dirEl = document.createElement("span");
      dirEl.className = "edit-summary-dir";
      dirEl.textContent = dir;
      row.appendChild(dirEl);
    }
    row.appendChild(buildStat(file.added, file.removed));
    row.addEventListener("click", () => open(file));
    item.appendChild(row);
    if (index >= EDIT_SUMMARY_COLLAPSED_ROWS) {
      item.hidden = true;
      overflow.push(item);
    }
    list.appendChild(item);
  });
  summaryFold(card, overflow, summary.files.length, false);
  return card;
}
