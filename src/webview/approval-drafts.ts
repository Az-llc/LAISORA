import type { ElicitationValue } from "../elicitation";
import { vscode } from "./dom";

export interface AskQuestionDraft {
  selected: string[];
  other: string;
}

export type ApprovalDraft = { questions: AskQuestionDraft[] } | { form: Record<string, ElicitationValue | undefined> };

export type ApprovalDrafts = Record<string, Record<string, ApprovalDraft>>;

export function withApprovalDraft(all: ApprovalDrafts | undefined, tabId: string, requestId: string, draft: ApprovalDraft | undefined): ApprovalDrafts {
  const { [tabId]: tab, ...others } = all ?? {};
  const { [requestId]: _previous, ...rest } = tab ?? {};
  const next = draft === undefined ? rest : { ...rest, [requestId]: draft };
  return Object.keys(next).length === 0 ? others : { ...others, [tabId]: next };
}

export function approvalDraftOf(tabId: string, requestId: string): ApprovalDraft | undefined {
  return vscode.getState()?.approvalDrafts?.[tabId]?.[requestId];
}

export function saveApprovalDraft(tabId: string, requestId: string, draft: ApprovalDraft | undefined): void {
  const state = vscode.getState() ?? { activeTabId: null };
  if (draft === undefined && state.approvalDrafts?.[tabId]?.[requestId] === undefined) return;
  vscode.setState({ ...state, approvalDrafts: withApprovalDraft(state.approvalDrafts, tabId, requestId, draft) });
}

export function dropApprovalDrafts(tabId: string, requestIds?: Iterable<string>): void {
  const state = vscode.getState();
  const tab = state?.approvalDrafts?.[tabId];
  if (state === undefined || tab === undefined) return;
  let approvalDrafts = state.approvalDrafts;
  for (const requestId of requestIds ?? Object.keys(tab)) {
    if (tab[requestId] !== undefined) approvalDrafts = withApprovalDraft(approvalDrafts, tabId, requestId, undefined);
  }
  if (approvalDrafts !== state.approvalDrafts) vscode.setState({ ...state, approvalDrafts });
}
