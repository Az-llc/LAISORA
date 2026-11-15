import { EMPTY_ASK_MARKS, type AskMarkEdit, type AskMarks, type AskMarksOrigin } from "../protocol";
import { applyAskMarkEdit } from "../ask-mark-edits";
import { vscode, type WebviewState } from "./dom";

const CLIENT = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let seq = 0;
let pending: { seq: number; edit: AskMarkEdit }[] = [];
let marks: AskMarks = EMPTY_ASK_MARKS;

export function askMarks(): AskMarks {
  return marks;
}

const elsewhereListeners = new Set<() => void>();

export function onAskMarksFromElsewhere(listener: () => void): () => void {
  elsewhereListeners.add(listener);
  return () => elsewhereListeners.delete(listener);
}

export function receiveAskMarks(host: AskMarks, origin?: AskMarksOrigin): void {
  const own = origin?.client === CLIENT;
  if (own) pending = pending.filter((entry) => entry.seq > origin.seq);
  marks = pending.reduce((next, entry) => applyAskMarkEdit(next, entry.edit), host);
  if (!own) for (const listener of elsewhereListeners) listener();
}

export function editAskMarks(edit: AskMarkEdit): void {
  const next = applyAskMarkEdit(marks, edit);
  if (next === marks) return;
  marks = next;
  pending.push({ seq: ++seq, edit });
  vscode.postMessage({ type: "askMarkEdit", client: CLIENT, seq, edit });
}

interface LegacyAskMarksState {
  askDismissedMessages?: string[];
  askResolvedMessages?: string[];
  askCheckedMessages?: Record<string, boolean[]>;
  askCheckedTags?: Record<string, string>;
  askCheckedPosted?: Record<string, true>;
}

const LEGACY_FIELDS = ["askDismissedMessages", "askResolvedMessages", "askCheckedMessages", "askCheckedTags", "askCheckedPosted"] as const;

export function adoptAskMarks(host: AskMarks): void {
  receiveAskMarks(host);
  const state = vscode.getState() as (WebviewState & LegacyAskMarksState) | undefined;
  if (state === undefined || LEGACY_FIELDS.every((field) => state[field] === undefined)) return;
  const rest: Record<string, unknown> = { ...state };
  for (const field of LEGACY_FIELDS) delete rest[field];
  vscode.setState(rest as unknown as WebviewState);
  editAskMarks({ kind: "legacy", marks: {
    dismissed: state.askDismissedMessages ?? [], resolved: state.askResolvedMessages ?? [],
    checked: state.askCheckedMessages ?? {}, checkedTags: state.askCheckedTags ?? {}, checkedPosted: state.askCheckedPosted ?? {},
  } });
}
