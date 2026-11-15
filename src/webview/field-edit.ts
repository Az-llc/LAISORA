export interface FieldEdit {
  text: string;
  dirty: boolean;
  written: string | null;
}

export type FieldReply = "none" | "saved" | "failed";

export function settleFieldEdit(edit: FieldEdit, reply: FieldReply, saved: string): FieldEdit {
  if (reply === "failed") return { text: saved, dirty: false, written: null };
  if (edit.dirty && !(reply === "saved" && edit.text === edit.written)) {
    return { text: edit.text, dirty: edit.text !== saved, written: reply === "saved" ? null : edit.written };
  }
  return { text: saved, dirty: false, written: null };
}

export function fieldLeaveCommits(edit: FieldEdit, tried: string | null): boolean {
  return edit.dirty && edit.text !== edit.written && edit.text !== tried;
}
