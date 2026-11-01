const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool);
}

export type ShellDialect = "posix" | "powershell" | "cmd";

export function toolDialect(tool: string): ShellDialect {
  return tool === "PowerShell" ? "powershell" : "posix";
}

export const MAX_SCRIPT_NESTING = 64;

export interface ShellHeredoc { readonly body: string; readonly literal: boolean }
export interface ShellBlock { readonly index: number; readonly body: string; readonly script: boolean }

export type ShellSeparator = "start" | ";" | "&&" | "||" | "|" | "&" | "(" | ")" | "{" | "}" | "case" | "end";
export interface ShellSubshell { readonly depth: number; readonly parent?: ShellSubshell }

export interface ShellSegment {
  readonly after: ShellSeparator;
  readonly ended: ShellSeparator;
  readonly grouped: boolean;
  readonly subshell?: ShellSubshell;
  readonly words: readonly string[];
  readonly operators: readonly number[];
  readonly quoted: readonly number[];
  readonly quotedStart: readonly number[];
  readonly commandStarts: readonly number[];
  readonly substitutions: readonly string[];
  readonly blocks: readonly ShellBlock[];
  readonly heredocs: readonly ShellHeredoc[];
  readonly piped: boolean;
  readonly listItems: ReadonlyMap<string, readonly string[]>;
}

export interface ShellSyntax {
  readonly segments: readonly ShellSegment[];
  readonly balanced: boolean;
  readonly literalBackticks: boolean;
  readonly exceeded: boolean;
}

interface Scan extends ShellSyntax { readonly end: number; readonly closed: boolean }

const CMD_SEPARATORS = ",;=";
const ONCE_BLOCK_KEYWORDS = new Set(["if", "elseif", "else", "try", "catch", "finally"]);
const C_ESCAPES: Readonly<Record<string, string>> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
const POWERSHELL_ESCAPES: Readonly<Record<string, string>> = Object.fromEntries([...Object.entries(C_ESCAPES).filter(([name]) => name === name.toLowerCase()), ["0", "\0"]]);

function codePoint(hex: string): string {
  const value = parseInt(hex, 16);
  return value <= 0x10ffff ? String.fromCodePoint(value) : "�";
}

function powershellEscape(text: string, at: number): { value: string; length: number } {
  const unicode = /^u\{([0-9A-Fa-f]{1,6})\}/.exec(text.slice(at, at + 9));
  if (unicode) return { value: codePoint(unicode[1]), length: unicode[0].length };
  return { value: POWERSHELL_ESCAPES[text[at]] ?? text[at], length: 1 };
}

export const LITERAL_DOLLAR = "";
const literal = (ch: string) => ch === "$" ? LITERAL_DOLLAR : ch;
export const withDollars = (text: string) => text.replaceAll(LITERAL_DOLLAR, "$");

function powershellUnescape(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "`" || i + 1 >= text.length) { result += text[i]; continue; }
    const escaped = powershellEscape(text, i + 1);
    result += literal(escaped.value);
    i += escaped.length;
  }
  return result;
}

export function unescapeSequences(text: string): string {
  return text.replace(/\\(?:([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|(.))/gs,
    (_, octal?: string, hex?: string, short?: string, long?: string, ch?: string) =>
      octal ? String.fromCharCode(parseInt(octal, 8)) : hex ? codePoint(hex) : short ?? long ? codePoint((short ?? long)!) : C_ESCAPES[ch!] ?? ch!);
}

export function hashtableStatements(body: string): string {
  return body.replace(/(^|[;\n])(\s*)(?:'[^']*'|"[^"]*"|[^\s=;'"{}()]+)\s*=(?!=)/g, "$1$2");
}

function backtickEnd(text: string, start: number, stop?: string): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "`") return i;
    if (text[i] === stop) return -1;
  }
  return -1;
}

function braceWordEnd(text: string, start: number): { close: number; stop: number } {
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "'" || ch === "\"") {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) return { close: -1, stop: text.length };
      i = end;
      continue;
    }
    if (ch === "}") return { close: i, stop: i };
    if (/[\s;&|<>()`]/.test(ch)) return { close: -1, stop: i };
  }
  return { close: -1, stop: text.length };
}

export interface ScanBudget { remaining: number }

function arithmeticEnd(text: string, start: number, close: "))" | "]"): number {
  const opener = close === "]" ? "[" : "(", closer = close === "]" ? "]" : ")";
  let level = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "`") {
      const end = backtickEnd(text, i + 1);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === opener) level++;
    else if (ch === closer) {
      if (level > 0) level--;
      else return close === "]" ? i : text[i + 1] === ")" ? i + 1 : -1;
    }
  }
  return -1;
}

export function isFdDuplication(operator: string): boolean {
  return /&[\d-]+$/.test(operator);
}

function scan(source: string, start: number, dialect: ShellDialect, stop: ")" | "}" | undefined, depth: number, budget: ScanBudget, expansion = false): Scan {
  const posix = dialect === "posix", powershell = dialect === "powershell", cmd = dialect === "cmd";
  const segments: ShellSegment[] = [];
  let balanced = true, literalBackticks = false, exceeded = depth > MAX_SCRIPT_NESTING || budget.remaining < 0;
  if (exceeded) return { segments, end: source.length, closed: false, balanced: false, literalBackticks, exceeded };
  let words: string[] = [], operators: number[] = [], quoted: number[] = [], quotedStart: number[] = [], commandStarts: number[] = [];
  let substitutions: string[] = [], blocks: ShellBlock[] = [], attached: ShellHeredoc[] = [];
  let listSeparators: number[] = [], wordListSeparators = new Map<number, number[]>(), stopParsing = false;
  let piped = false, nextPiped = false, word = "", inWord = false, wordQuoted = false, wordStartQuoted = false, afterParen = false, parens = 0, braces = 0, literalBracesUntil = -1, programFound = false;
  let casePattern = false, patternStart = 0;
  const cases: { parens: number; braces: number }[] = [];
  let separator: ShellSeparator = "start", grouped = false, subshell: ShellSubshell | undefined, segmentSubshell: ShellSubshell | undefined;
  let heredocOperator: { strip: boolean } | undefined;
  const pending: { delimiter: string; strip: boolean; literal: boolean; docs: ShellHeredoc[]; subs: string[] }[] = [];
  const spend = (amount: number) => { budget.remaining -= amount; if (budget.remaining < 0) exceeded = true; };
  const nested = (text: string, at: number, close: ")" | "}", inExpansion = false): Scan | undefined => {
    const inner = scan(text, at, dialect, close, depth + 1, budget, inExpansion);
    exceeded ||= inner.exceeded;
    if (!inner.closed) return undefined;
    balanced &&= inner.balanced;
    literalBackticks ||= inner.literalBackticks;
    return inner;
  };
  const arithmetic = (text: string, at: number, close: "))" | "]"): number => {
    const end = arithmeticEnd(text, at, close);
    spend((end < 0 ? text.length : end) - at + 1);
    return end;
  };
  const expanded = (content: string, into: string[]) => {
    for (let i = 0; i < content.length && !exceeded; i++) {
      spend(1);
      const ch = content[i];
      if (posix && ch === "\\" || powershell && ch === "`") { i++; continue; }
      if (posix && ch === "$" && content[i + 1] === "(" && content[i + 2] === "(") {
        const end = arithmetic(content, i + 3, "))");
        if (end >= 0) { expanded(content.slice(i + 3, end - 1), into); i = end; continue; }
      }
      if (ch === "$" && content[i + 1] === "(" && !cmd) {
        const close = nested(content, i + 2, ")")?.end;
        if (close === undefined) { balanced = false; return; }
        into.push(content.slice(i + 2, close));
        i = close;
      } else if (posix && ch === "`") {
        const close = backtickEnd(content, i + 1);
        if (close < 0) { literalBackticks = true; continue; }
        into.push(content.slice(i + 1, close));
        i = close;
      }
    }
  };
  const commandPosition = (index: number) => words.slice(0, index).every((prefix, i) => !quoted.includes(i) && SHELL_CONDITION_WORDS.has(prefix));
  const unwindCases = () => {
    while (cases.length && (cases[cases.length - 1].parens > parens || cases[cases.length - 1].braces > braces)) { cases.pop(); casePattern = false; balanced = false; }
  };
  const registerList = (listItems: Map<string, string[]>, text: string, separators: readonly number[]) => {
    const items = listItems.get(text) ?? [];
    let from = 0;
    for (const separator of [...separators, text.length]) { if (separator > from) items.push(text.slice(from, separator)); from = separator + 1; }
    listItems.set(text, items);
    const colon = powershell && /^-[A-Za-z][\w-]*:/.test(text) ? text.indexOf(":") : -1;
    if (colon >= 0) registerList(listItems, text.slice(colon + 1), separators.filter(separator => separator > colon).map(separator => separator - colon - 1));
  };
  const listContinues = () => powershell && !stopParsing && inWord && listSeparators.length > 0 && listSeparators[listSeparators.length - 1] === word.length - 1;
  const endWord = () => {
    if (inWord && listSeparators.length) wordListSeparators.set(words.length, listSeparators);
    listSeparators = [];
    if (powershell && inWord && !wordQuoted && word === "--%") stopParsing = true;
    if (inWord) {
      if (heredocOperator) { pending.push({ delimiter: word, strip: heredocOperator.strip, literal: wordQuoted, docs: attached, subs: substitutions }); heredocOperator = undefined; }
      const bare = posix && !wordQuoted;
      if (bare && cases.length && word === "esac" && words.length === (casePattern ? patternStart : 0)) {
        const open = cases.pop()!;
        if (open.parens !== parens || open.braces !== braces) balanced = false;
        casePattern = false;
      }
      if (wordQuoted) quoted.push(words.length);
      if (wordStartQuoted) quotedStart.push(words.length);
      if (afterParen) commandStarts.push(words.length);
      words.push(word);
      afterParen = false;
      const subject = words.length - 3;
      if (bare && word === "in" && subject >= 0 && words[subject] === "case" && !quoted.includes(subject) && commandPosition(subject)) {
        cases.push({ parens, braces }); casePattern = true; patternStart = words.length;
      }
    }
    word = ""; inWord = false; wordQuoted = false; wordStartQuoted = false;
  };
  const endSegment = (ended: ShellSeparator = ";") => {
    endWord();
    const listItems = new Map<string, string[]>();
    for (const [index, separators] of wordListSeparators) registerList(listItems, words[index], separators);
    if (words.length || blocks.length || substitutions.length || attached.length) {
      segments.push({ after: separator, ended, grouped: grouped || cases.length > 0, subshell: segmentSubshell, words, operators, quoted, quotedStart, commandStarts, substitutions, blocks, heredocs: attached, piped, listItems });
      separator = ended;
    } else if (separator !== "&&" && separator !== "||" && separator !== "|") separator = ended;
    words = []; operators = []; quoted = []; quotedStart = []; commandStarts = []; substitutions = []; blocks = []; attached = []; wordListSeparators = new Map();
    piped = nextPiped; nextPiped = false; afterParen = false; programFound = false; patternStart = 0;
    grouped = parens + braces > 0; segmentSubshell = subshell;
  };
  const endPattern = () => {
    endWord();
    const kept = (index: number) => index < patternStart;
    words = words.slice(0, patternStart); quoted = quoted.filter(kept); quotedStart = quotedStart.filter(kept); operators = operators.filter(kept); commandStarts = commandStarts.filter(kept);
    casePattern = false;
    endSegment("case");
  };
  const readHeredocs = (from: number): number => {
    let at = from;
    for (const doc of pending.splice(0)) {
      const lines: string[] = [];
      let terminated = false;
      while (at < source.length) {
        const newline = source.indexOf("\n", at);
        const line = source.slice(at, newline < 0 ? source.length : newline);
        at = newline < 0 ? source.length : newline + 1;
        const content = doc.strip ? line.replace(/^\t+/, "") : line;
        if (content === doc.delimiter) { terminated = true; break; }
        lines.push(content);
      }
      if (!terminated) balanced = false;
      const body = lines.join("\n");
      doc.docs.push({ body, literal: doc.literal });
      if (!doc.literal) expanded(body, doc.subs);
    }
    return at;
  };
  const hasProgram = (): boolean => {
    if (programFound) return true;
    if (inWord) words.push(word);
    programFound = words.length > 0 && segmentProgram({ words, quoted }).index < words.length;
    if (inWord) words.pop();
    return programFound;
  };
  const braceMode = (at: number): "inline" | "block" | "data" | "word" => {
    const first = quoted[0] === 0 ? "" : (words[0] ?? (inWord ? word : "")).toLowerCase();
    if (powershell) return inWord && word === "@" ? "data" : ONCE_BLOCK_KEYWORDS.has(first) ? "inline" : "block";
    if (/\s/.test(source[at + 1] ?? "") && !hasProgram()) return "inline";
    return first === "function" || /\(\s*\)\s*$/.test(source.slice(Math.max(start, at - 64), at)) ? "block" : "word";
  };
  const result = (end: number, closed: boolean): Scan => ({ segments, end, closed, balanced: balanced && !pending.length && !cases.length, literalBackticks, exceeded });
  let charged = start;
  for (let i = start; i < source.length; i++) {
    spend(i + 1 - charged);
    charged = i + 1;
    if (exceeded) break;
    const ch = source[i];
    if (posix && ch === "\\" || powershell && ch === "`" || cmd && ch === "^") {
      if (source[i + 1] === "\n") { i++; continue; }
      if (i + 1 < source.length) {
        if (cmd && CMD_SEPARATORS.includes(source[i + 1])) listSeparators.push(word.length);
        if (!inWord) wordStartQuoted = true;
        word += cmd ? source[++i] : literal(source[++i]); inWord = true; wordQuoted = true; continue;
      }
    }
    if (powershell && (ch === "'" || ch === "\"") && inWord && word === "@" && source[i + 1] === "\n") {
      const close = source.indexOf("\n" + ch + "@", i + 1);
      const content = source.slice(i + 2, close < 0 ? source.length : close);
      if (close < 0) balanced = false;
      if (ch === "\"") expanded(content, substitutions);
      word = ch === "\"" ? powershellUnescape(content) : content.replaceAll("$", LITERAL_DOLLAR); wordQuoted = true; wordStartQuoted = true;
      i = close < 0 ? source.length : close + 2;
      continue;
    }
    if (ch === "'" && !cmd) {
      const ansi = posix && inWord && word.endsWith("$");
      if (ansi) word = word.slice(0, -1);
      if (!inWord || ansi && word === "") wordStartQuoted = true;
      let end = i + 1, raw = "";
      for (; end < source.length; end++) {
        if (ansi && source[end] === "\\" && end + 1 < source.length) { raw += source[end] + source[++end]; continue; }
        if (source[end] !== "'") { raw += source[end]; continue; }
        if (powershell && source[end + 1] === "'") { raw += "'"; end++; continue; }
        break;
      }
      if (end >= source.length) balanced = false;
      word += (ansi ? unescapeSequences(raw) : raw).replaceAll("$", LITERAL_DOLLAR);
      inWord = true; wordQuoted = true; i = end;
      continue;
    }
    if (ch === "\"") {
      if (!inWord) wordStartQuoted = true;
      let end = i + 1;
      for (; end < source.length; end++) {
        const inner = source[end];
        if (cmd) { if (inner === "\"" || inner === "\n") break; word += inner; continue; }
        if (inner === "\"") { if (powershell && source[end + 1] === "\"") { word += inner; end++; continue; } break; }
        if (posix && inner === "\\" && ["\"", "\\", "$", "`", "\n"].includes(source[end + 1])) { if (source[++end] !== "\n") word += literal(source[end]); continue; }
        if (powershell && inner === "`" && end + 1 < source.length) {
          const escaped = powershellEscape(source, end + 1);
          word += literal(escaped.value);
          end += escaped.length;
          continue;
        }
        if (posix && inner === "$" && source[end + 1] === "(" && source[end + 2] === "(") {
          const close = arithmetic(source, end + 3, "))");
          if (close >= 0) { expanded(source.slice(end + 3, close - 1), substitutions); word += source.slice(end, close + 1); end = close; continue; }
        }
        if (inner === "$" && source[end + 1] === "(") {
          const close = nested(source, end + 2, ")")?.end;
          if (close === undefined) { end = source.length; break; }
          substitutions.push(source.slice(end + 2, close));
          word += source.slice(end, close + 1);
          end = close;
          continue;
        }
        if (posix && inner === "`") {
          const close = backtickEnd(source, end + 1);
          if (close < 0) { literalBackticks = true; word += inner; continue; }
          substitutions.push(source.slice(end + 1, close));
          word += source.slice(end, close + 1);
          end = close;
          continue;
        }
        word += inner;
      }
      if (end >= source.length && !cmd) balanced = false;
      inWord = true; wordQuoted = true; i = cmd && source[end] === "\n" ? end - 1 : end;
      continue;
    }
    if (!cmd && !stopParsing && (!inWord || listContinues()) && !expansion && ch === "#") {
      const newline = source.indexOf("\n", i);
      i = (newline < 0 ? source.length : newline) - 1;
      continue;
    }
    if (powershell && !stopParsing && (!inWord || listContinues()) && ch === "<" && source[i + 1] === "#") {
      const close = source.indexOf("#>", i + 2);
      if (close < 0) { balanced = false; break; }
      i = close + 1;
      continue;
    }
    if (posix && ch === "$" && (source[i + 1] === "[" || source[i + 1] === "(" && source[i + 2] === "(")) {
      const square = source[i + 1] === "[", from = i + (square ? 2 : 3);
      const end = arithmetic(source, from, square ? "]" : "))");
      if (end >= 0) {
        expanded(source.slice(from, square ? end : end - 1), substitutions);
        word += source.slice(i, end + 1); inWord = true; i = end;
        continue;
      }
    }
    if (!cmd && source[i + 1] === "(" && (ch === "$" || !inWord && (powershell && ch === "@" || posix && (ch === "<" || ch === ">")))) {
      const close = nested(source, i + 2, ")")?.end;
      if (close === undefined) { balanced = false; break; }
      substitutions.push(source.slice(i + 2, close));
      word += source.slice(i, close + 1);
      inWord = true; i = close;
      continue;
    }
    if (posix && ch === "`") {
      const close = backtickEnd(source, i + 1);
      if (close < 0) { literalBackticks = true; word += ch; inWord = true; continue; }
      substitutions.push(source.slice(i + 1, close));
      word += source.slice(i, close + 1);
      inWord = true; i = close;
      continue;
    }
    if (!cmd && ch === "{") {
      if (inWord && word.endsWith("$")) {
        const inner = nested(source, i + 1, "}", true);
        if (!inner) { balanced = false; break; }
        const close = inner.end, content = source.slice(i + 1, close);
        for (const segment of inner.segments) substitutions.push(...segment.substitutions);
        word = word.slice(0, -1) + (/^[A-Za-z_][A-Za-z0-9_]*$/.test(content) && !/^\w/.test(source[close + 1] ?? "") ? "$" + content : "${" + content + "}");
        i = close;
        continue;
      }
      const mode = braceMode(i);
      if (mode === "inline") { endSegment("{"); braces++; grouped = true; continue; }
      if (mode === "word") {
        const expansion = i < literalBracesUntil ? undefined : braceWordEnd(source, i + 1);
        if (expansion && expansion.close >= 0) { word += source.slice(i, expansion.close + 1); inWord = true; i = expansion.close; continue; }
        if (expansion) literalBracesUntil = expansion.stop;
        word += ch; inWord = true;
        continue;
      }
      const close = nested(source, i + 1, "}")?.end;
      if (close === undefined) { balanced = false; break; }
      if (mode === "block") endWord();
      else { word += source.slice(i, close + 1); inWord = true; }
      blocks.push({ index: words.length, body: source.slice(i + 1, close), script: mode === "block" });
      i = close;
      continue;
    }
    if (!cmd && ch === "}") {
      if (braces > 0) { endSegment("}"); braces--; grouped = parens + braces > 0; unwindCases(); continue; }
      endWord();
      if (stop === "}") { endSegment("end"); return result(i, true); }
      continue;
    }
    if (ch === ")") {
      endWord();
      if (casePattern) { endPattern(); continue; }
      if (parens > 0) { parens--; endSegment(")"); subshell = subshell?.parent; segmentSubshell = subshell; unwindCases(); }
      else if (stop === ")") { endSegment("end"); return result(i, true); }
      afterParen = true;
      continue;
    }
    if (ch === "(") {
      if (casePattern && !inWord && words.length === patternStart) continue;
      if (posix && !inWord && source[i + 1] === "(") {
        const end = arithmetic(source, i + 2, "))");
        if (end >= 0) {
          expanded(source.slice(i + 2, end - 1), substitutions);
          word += source.slice(i, end + 1); inWord = true; i = end;
          continue;
        }
      }
      if (powershell || posix && inWord) {
        const inner = nested(source, i + 1, ")");
        if (!inner) { balanced = false; break; }
        substitutions.push(source.slice(i + 1, inner.end));
        word += source.slice(i, inner.end + 1); inWord = true; i = inner.end;
        continue;
      }
      endSegment("(");
      parens++; grouped = true;
      if (posix) segmentSubshell = subshell = { depth: (subshell?.depth ?? 0) + 1, parent: subshell };
      afterParen = true;
      continue;
    }
    if (ch === "\n") {
      if (listContinues()) continue;
      endSegment(";");
      stopParsing = false;
      if (pending.length) i = readHeredocs(i + 1) - 1;
      continue;
    }
    if (ch === ";" && !cmd) {
      endWord();
      if (casePattern) balanced = false;
      endSegment(";");
      if (cases.length && (source[i + 1] === ";" || source[i + 1] === "&")) { i += source[i + 1] === ";" && source[i + 2] === "&" ? 2 : 1; casePattern = true; }
      continue;
    }
    if (ch === "|" || ch === "&") {
      endWord();
      if (casePattern && ch === "|") continue;
      if (casePattern) balanced = false;
    }
    if (posix && ch === "&" && source[i + 1] === ">") {
      let op = "&>";
      i++;
      if (source[i + 1] === ">") { op += ">"; i++; }
      operators.push(words.length); words.push(op);
      continue;
    }
    if (ch === "&" || ch === "|") {
      const doubled = source[i + 1] === ch;
      if (doubled) i++;
      else if (posix && ch === "|" && source[i + 1] === "&") i++;
      nextPiped = ch === "|" && !doubled;
      endSegment(doubled ? (ch === "&" ? "&&" : "||") : ch);
      if (ch === "|") stopParsing = false;
      continue;
    }
    if (ch === ">" || ch === "<") {
      const digitPrefix = inWord && !wordQuoted && (/^\d$/.test(word) || powershell && ch === ">" && word === "*");
      if (!digitPrefix) endWord();
      let op = digitPrefix ? word + ch : ch;
      word = ""; inWord = false; wordQuoted = false;
      if (source[i + 1] === ch) {
        op += ch; i++;
        if (ch === "<" && source[i + 1] === "<") { op += ch; i++; }
        else if (posix && ch === "<") { heredocOperator = { strip: source[i + 1] === "-" }; if (heredocOperator.strip) i++; }
      }
      if (posix && ch === ">" && source[i + 1] === "|") { op += "|"; i++; }
      else if (source[i + 1] === "&") {
        let j = i + 2;
        while (j < source.length && !/[\s;|&<>()]/.test(source[j])) j++;
        const duplication = op + source.slice(i + 1, j);
        if (isFdDuplication(duplication)) { op = duplication; i = j - 1; }
        else { op += "&"; i++; }
      }
      operators.push(words.length); words.push(op);
      continue;
    }
    if (/\s/.test(ch)) { if (!listContinues()) endWord(); continue; }
    if (powershell && !stopParsing && ch === ",") {
      const last = words.length - 1;
      if (!inWord && last >= 1 && !operators.includes(last) && (quoted.includes(last) || !words[last].startsWith("-"))) {
        word = words.pop()!;
        wordQuoted = quoted.includes(last);
        wordStartQuoted = quotedStart.includes(last);
        quoted = quoted.filter(index => index !== last);
        quotedStart = quotedStart.filter(index => index !== last);
        listSeparators = wordListSeparators.get(last) ?? [];
        wordListSeparators.delete(last);
      }
      listSeparators.push(word.length);
    } else if (cmd && CMD_SEPARATORS.includes(ch)) listSeparators.push(word.length);
    word += ch;
    inWord = true;
  }
  endSegment("end");
  return result(source.length, false);
}

export function shellSyntax(command: string, dialect: ShellDialect = "posix", budget: ScanBudget = { remaining: Infinity }): ShellSyntax {
  const parsed = scan(command.replace(/\r\n?/g, "\n"), 0, dialect, undefined, 0, budget);
  return { segments: parsed.segments, balanced: parsed.balanced && !parsed.exceeded, literalBackticks: parsed.literalBackticks, exceeded: parsed.exceeded };
}

export const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

const SHELL_CONDITION_WORDS = new Set(["if", "then", "else", "elif", "elseif", "do", "while", "until", "!"]);
const POWERSHELL_VARIABLE_RE = /^\$[A-Za-z_][\w:]*$/;
export const POWERSHELL_ASSIGNMENT_RE = /^(?:[-+*/%]|\?\?)?=$/;
export const POWERSHELL_ATTACHED_ASSIGNMENT_RE = /^\$[A-Za-z_][\w:]*(?:[-+*/%]|\?\?)?=$/;
const POWERSHELL_CAST_RE = /^\[[A-Za-z_][\w.]*\]$/;

interface WrapperSyntax {
  readonly flags: readonly string[];
  readonly values: readonly string[];
  readonly writes?: readonly string[];
  readonly queries?: readonly string[];
  readonly operand?: boolean;
  readonly numeric?: boolean;
  readonly assignments?: boolean;
  readonly shell?: boolean;
  readonly direct?: readonly string[];
}

export const QUERY_OPTIONS: readonly string[] = ["--help", "--version"];
const TRANSPARENT_WRAPPERS: ReadonlyMap<string, WrapperSyntax> = new Map([
  ["timeout", { flags: ["--preserve-status", "--foreground", "-v", "--verbose"], values: ["-s", "--signal", "-k", "--kill-after"], operand: true }],
  ["time", { flags: ["-p", "--portability", "-a", "--append", "-v", "--verbose", "-q", "--quiet"], values: ["-f", "--format"], writes: ["-o", "--output"] }],
  ["nohup", { flags: [], values: [] }],
  ["env", { flags: ["-i", "--ignore-environment", "-"], values: ["-u", "--unset"], assignments: true }],
  ["command", { flags: ["-p"], values: [], queries: ["-v", "-V"] }],
  ["exec", { flags: ["-c", "-l"], values: ["-a"] }],
  ["builtin", { flags: [], values: [] }],
  ["nice", { flags: [], values: ["-n", "--adjustment"], numeric: true }],
  ["setsid", { flags: ["-c", "--ctty", "-f", "--fork", "-w", "--wait"], values: [] }],
  ["stdbuf", { flags: [], values: ["-i", "--input", "-o", "--output", "-e", "--error"] }],
  ["sudo", { flags: ["-A", "--askpass", "-b", "--background", "-E", "--preserve-env", "-H", "--set-home", "-i", "--login", "-n", "--non-interactive", "-P", "--preserve-groups",
    "-S", "--stdin", "-s", "--shell", "-k", "--reset-timestamp"], values: ["-C", "--close-from", "-g", "--group", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-T", "--command-timeout",
    "-U", "--other-user", "-u", "--user"], queries: ["-V", "-l", "--list", "-v", "--validate", "-K", "--remove-timestamp"], assignments: true }],
  ["doas", { flags: ["-n", "-s"], values: ["-u"], queries: ["-C"] }],
  ["watch", { flags: ["-b", "--beep", "-c", "--color", "-C", "--no-color", "-d", "--differences", "-e", "--errexit", "-g", "--chgexit", "-t", "--no-title", "-p", "--precise",
    "-w", "--no-wrap", "-r", "--no-rerun", "-x", "--exec"], values: ["-n", "--interval", "-q", "--equexit", "-s", "--shotsdir"], shell: true, direct: ["-x", "--exec"] }],
]);

export interface SegmentProgram {
  readonly index: number;
  readonly writes: readonly string[];
  readonly unclassified: boolean;
  readonly script?: number;
}

export function segmentProgram(segment: Pick<ShellSegment, "words" | "quoted">): SegmentProgram {
  const words = segment.words, quoted = new Set(segment.quoted), writes: string[] = [];
  const bare = (index: number) => !quoted.has(index);
  let index = 0;
  for (;;) {
    while (index < words.length && ASSIGNMENT_RE.test(words[index])) index++;
    if (index >= words.length) return { index, writes, unclassified: false };
    const word = words[index].toLowerCase();
    if (bare(index) && SHELL_CONDITION_WORDS.has(word)) {
      index++;
      if (words[index] === "$?" && ["if", "elseif", "elif", "while", "until"].includes(word)) index++;
      continue;
    }
    if (bare(index) && POWERSHELL_VARIABLE_RE.test(words[index]) && POWERSHELL_ASSIGNMENT_RE.test(words[index + 1] ?? "")) { index += 2; continue; }
    if (bare(index) && (POWERSHELL_ATTACHED_ASSIGNMENT_RE.test(words[index]) || POWERSHELL_CAST_RE.test(words[index]))) { index++; continue; }
    const syntax = TRANSPARENT_WRAPPERS.get(programName(word));
    if (!syntax) return { index, writes, unclassified: false };
    const unclassified = { index, writes, unclassified: true };
    let next = index + 1, direct = false;
    while (next < words.length) {
      const option = words[next];
      direct ||= syntax.direct?.includes(option) ?? false;
      if (option === "--") { next++; break; }
      if (!option.startsWith("-") || option === "-" && !syntax.flags.includes(option)) break;
      if (QUERY_OPTIONS.includes(option) || syntax.queries?.includes(option)) return { index: words.length, writes, unclassified: false };
      if (syntax.flags.includes(option) || syntax.numeric && /^-\d+$/.test(option)) { next++; continue; }
      const name = option.startsWith("--") ? option.split("=", 1)[0] : option.slice(0, 2);
      const attached = name === option ? undefined : option.slice(name.length + (option.startsWith("--") ? 1 : 0));
      const writing = syntax.writes?.includes(name) ?? false;
      if (!writing && !syntax.values.includes(name)) return unclassified;
      const value = attached ?? words[next + 1];
      if (value === undefined) return unclassified;
      if (writing) writes.push(value);
      next += attached === undefined ? 2 : 1;
    }
    if (syntax.assignments) while (next < words.length && words[next].includes("=")) next++;
    if (syntax.operand) next++;
    if (syntax.shell && !direct) return { index: next, writes, unclassified: false, script: next };
    index = next;
  }
}
