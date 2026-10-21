const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool);
}

export interface ShellSegment { readonly words: readonly string[]; readonly operators?: readonly number[] }

function stripHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/);
  const kept: string[] = [];
  let delimiter: string | undefined;
  for (const line of lines) {
    if (delimiter !== undefined) {
      if (line.trim() === delimiter) delimiter = undefined;
      continue;
    }
    kept.push(line);
    const opened = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (opened) delimiter = opened[2];
  }
  return kept.join("\n");
}

export function shellSegments(command: string, trackOperators = false): ShellSegment[] {
  const text = stripHeredocBodies(command);
  const segments: ShellSegment[] = [];
  let words: string[] = [];
  let operators: number[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => { if (inWord) words.push(word); word = ""; inWord = false; };
  const endSegment = () => { endWord(); if (words.length) segments.push({ words, ...(trackOperators ? { operators } : {}) }); words = []; operators = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === "\"") {
      let end = i + 1, quoted = "";
      for (; end < text.length; end++) {
        if (text[end] === ch) break;
        if (ch === '"' && text[end] === "\\" && ['"', "\\", "$", "`"].includes(text[end + 1])) { quoted += text[++end]; continue; }
        quoted += text[end];
      }
      word += quoted;
      inWord = true;
      i = end;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length && SHELL_ESCAPABLE.has(text[i + 1])) { word += text[i + 1]; inWord = true; i++; continue; }
    if (ch === "\n" || ch === ";") { endSegment(); continue; }
    if (ch === "&" || ch === "|") {
      if (i > 0 && text[i - 1] === ">") { word += ch; inWord = true; continue; }
      if (text[i + 1] === ch) i++;
      endSegment();
      continue;
    }
    if (ch === ">" || ch === "<") {
      const digitPrefix = inWord && /^\d$/.test(word);
      if (!digitPrefix) endWord();
      let op = digitPrefix ? word + ch : ch;
      word = ""; inWord = false;
      if (text[i + 1] === ch) { op += ch; i++; }
      if (text[i + 1] === "&") { let j = i + 2; while (j < text.length && /[\d-]/.test(text[j])) j++; op += text.slice(i + 1, j); i = j - 1; }
      operators.push(words.length); words.push(op);
      continue;
    }
    if (/\s/.test(ch) || ch === "(" || ch === ")" || ch === "{" || ch === "}") { endWord(); continue; }
    word += ch;
    inWord = true;
  }
  endSegment();
  return segments;
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_ESCAPABLE = new Set([" ", "\t", "'", "\"", "\\", ";", "&", "|", "<", ">", "(", ")", "$", "`"]);

export function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

export function segmentProgramIndex(segment: ShellSegment): number {
  let index = 0;
  while (index < segment.words.length && ASSIGNMENT_RE.test(segment.words[index])) index++;
  return index;
}
