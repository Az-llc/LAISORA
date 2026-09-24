export function mergeAskChoice(
  current: string,
  askKey: string,
  title: string,
  newLine: string,
  rememberedLine?: string
): { text: string; caret: number; askKey: string } {
  const lines = [...current.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)];
  const content = (line: RegExpMatchArray) => line[0].replace(/[\r\n]+$/, "");
  const found = (rememberedLine === undefined ? undefined : lines.find(line => content(line) === rememberedLine))
    ?? lines.find(line => content(line).startsWith(`${title} → `));
  const start = found?.index ?? current.length;
  const separator = found || !current || /[\r\n]$/.test(current) ? "" : current.includes("\r\n") ? "\r\n" : "\n";
  const inserted = separator + newLine;
  return {
    text: current.slice(0, start) + inserted + current.slice(start + (found ? content(found).length : 0)),
    caret: start + inserted.length,
    askKey,
  };
}
