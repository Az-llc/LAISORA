import type { FileSuggestRow } from "./protocol";

function textMatchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

export function fileRowMatchesQuery(row: FileSuggestRow, query: string): boolean {
  return textMatchesQuery(row.workspaceRelative, query) || (row.insideCwd && textMatchesQuery(row.text, query));
}
