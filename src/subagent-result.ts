export function subagentResultForDisplay(text: string): string {
  return text.replace(/(^|\n)\[Subagent hand-back\](?: The text below is the final report[^\n]*The report follows:)?[ \t]*(?:\r?\n)?/g, "$1");
}
