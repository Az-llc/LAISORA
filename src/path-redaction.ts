import { escapeRegExp } from "./regexp-escape";

const PATH_CHAR = String.raw`[^\s"'\x60|;)\]}>\\<]`;
const PATH_RUN_CHAR = String.raw`(?:${PATH_CHAR}|\\(?!"))`;

const WIN_ABS = new RegExp(
  String.raw`(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))[A-Za-z]:(?:\\+|\/(?!\/)|(?<![A-Za-z0-9+.-][A-Za-z]:)\/+|(?<=\\[nrt][A-Za-z]:)\/+)${PATH_RUN_CHAR}*`,
  "g"
);
const UNC = new RegExp(String.raw`(?:(?<=^|[\s"'\x60=(\[{,:;<>|])\\{2,}|\\{4,})${PATH_RUN_CHAR}+`, "g");
const FILE_URI = new RegExp(String.raw`file:\/\/${PATH_RUN_CHAR}+`, "gi");
const POSIX_ABS = new RegExp(
  String.raw`(?<=^|[^\p{L}\p{N}\p{M}_./\\~%+-]|\\[nrt]|(?:^|[^\p{L}\p{N}\p{M}_./\\~%+-])-[A-Za-z])(?!(?<=<)\/[A-Za-z][\w:-]*>)(?!(?<=(?<!\\)[A-Za-z0-9+.-]:)\/\/)\/+(?!(?:dev|proc|sys)\/)${PATH_CHAR}+`,
  "gu"
);

export interface KnownPathRoot {
  readonly pattern: RegExp;
  readonly label: string;
}

export const HOME_ROOT_LABEL = "~";

const ROOT_SEPARATOR = String.raw`(?:\\(?!")|\/)+`;
const ROOT_START = String.raw`(?:(?<![A-Za-z0-9_./\\~%+-])(?<!(?:^|[^A-Za-z0-9])[A-Za-z]:)|(?<=\\[nrt]))`;
const ROOT_BARE_END = String.raw`(?=$|\s|[\x60|=]|[.,!?;:'")\]}>](?![A-Za-z0-9_-])|[、。，．！？」』）\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])`;

function nameChars(segment: string): string {
  return [...segment].map((ch) => {
    const encoded = encodeURIComponent(ch);
    return encoded === ch ? escapeRegExp(ch) : `(?:${escapeRegExp(ch)}|${escapeRegExp(encoded)})`;
  }).join("");
}

function compileHomeForm(home: string): KnownPathRoot | undefined {
  const drive = /^([A-Za-z]):[\\/]/.exec(home);
  const segments = home.split(/[\\/]+/).filter((s) => s.length > 0).slice(drive ? 1 : 0);
  if (segments.length === 0) return undefined;
  const chain = segments.map((s) => ROOT_SEPARATOR + nameChars(s)).join("");
  const start = drive
    ? String.raw`(?:file:\/{2,3}|\\+\?\\+)?(?:${drive[1]}(?::|%3A)|\/mnt\/${drive[1]}(?=[\\/])|\/${drive[1]}(?=[\\/]))`
    : String.raw`(?:file:\/\/)?`;
  return {
    pattern: new RegExp(`${ROOT_START}${start}${chain}(?:(${ROOT_SEPARATOR}${PATH_RUN_CHAR}*)|${ROOT_BARE_END})`, drive ? "giu" : "gu"),
    label: HOME_ROOT_LABEL,
  };
}

export function compileHomeRoot(home: string): KnownPathRoot[] {
  return [...new Set([home.normalize("NFC"), home.normalize("NFD")])]
    .map(compileHomeForm)
    .filter((r): r is KnownPathRoot => r !== undefined);
}

let hostPathRoots: readonly KnownPathRoot[] = [];

export function setHomeDirectory(home: string): void {
  hostPathRoots = compileHomeRoot(home);
}

export function basenameOf(token: string): string {
  const parts = token.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

export function redactPaths(text: string, roots: readonly KnownPathRoot[]): string {
  let out = text;
  for (const root of roots) out = out.replace(root.pattern, (_m, rest: string | undefined) => basenameOf(rest ?? "") || root.label);
  return out
    .replace(FILE_URI, (m) => basenameOf(m))
    .replace(WIN_ABS, (m) => basenameOf(m))
    .replace(UNC, (m) => basenameOf(m))
    .replace(POSIX_ABS, (m) => basenameOf(m));
}

export function containsAbsolutePath(text: string): boolean {
  return redactAbsolutePaths(text) !== text;
}

export function redactAbsolutePaths(text: string): string {
  return redactPaths(text, hostPathRoots);
}

export function redactOptional(text: string | undefined): string | undefined {
  return text === undefined ? undefined : redactAbsolutePaths(text);
}
