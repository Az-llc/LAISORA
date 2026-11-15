export function composerDraftsAfterInit(drafts: Readonly<Record<string, string>>, previousActive: string | null, chosen: string, inputValue: string): { drafts: Record<string, string>; composer: string } {
  const next = { ...drafts };
  if (previousActive !== null && next[previousActive] === undefined) next[previousActive] = inputValue;
  return { drafts: next, composer: next[chosen] ?? "" };
}
