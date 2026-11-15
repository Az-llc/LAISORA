import type * as vscode from "vscode";
import { extensionContext } from "./host-context";
import { EMPTY_ASK_MARKS, isAskMarks, type AskMarkEdit, type AskMarks, type AskMarksOrigin } from "./protocol";
import { applyAskMarkEdit } from "./ask-mark-edits";
import type { SessionStore } from "./store-surfaces";

const ASK_MARKS_KEY = "laisora.askMarks.v1";

let current: AskMarks | undefined;

function askMarksMemento(): vscode.Memento | undefined {
  return extensionContext?.workspaceState;
}

export function savedAskMarks(): AskMarks {
  if (current !== undefined) return current;
  const memento = askMarksMemento();
  if (memento === undefined) return EMPTY_ASK_MARKS;
  const saved = memento.get<unknown>(ASK_MARKS_KEY);
  current = isAskMarks(saved) ? saved : EMPTY_ASK_MARKS;
  return current;
}

export async function editAskMarks(st: SessionStore, edit: AskMarkEdit, origin: AskMarksOrigin): Promise<void> {
  const previous = savedAskMarks();
  const next = applyAskMarkEdit(previous, edit);
  current = next;
  st.post({ type: "askMarksChanged", marks: next, origin });
  if (next !== previous) await askMarksMemento()?.update(ASK_MARKS_KEY, next);
}
