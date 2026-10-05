const WIN_ABS = /[A-Za-z]:(?:\\+|\/(?!\/)|(?<![A-Za-z0-9+.-][A-Za-z]:)\/+|(?<=\\[nrt][A-Za-z]:)\/+)(?:[^\s"'`|;)\]}>\\<]|\\(?!"))*/g;
const UNC = /(?:(?<=^|[\s"'`=(\[{,:;<>|])\\{2,}|\\{4,})(?:[^\s"'`|;)\]}>\\<]|\\(?!"))+/g;
const FILE_URI = /file:\/\/(?:[^\s"'`|;)\]}>\\<]|\\(?!"))+/gi;
const POSIX_ABS = /(?<=^|[^\p{L}\p{N}\p{M}_./\\~%+-]|\\[nrt]|(?:^|[^\p{L}\p{N}\p{M}_./\\~%+-])-[A-Za-z])(?!(?<=<)\/[A-Za-z][\w:-]*>)(?!(?<=(?<!\\)[A-Za-z0-9+.-]:)\/\/)\/+(?!(?:dev|proc|sys)\/)[^\s"'`|;)\]}>\\<]+/gu;

function basenameOf(token: string): string {
  const parts = token.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

export function containsAbsolutePath(text: string): boolean {
  return redactAbsolutePaths(text) !== text;
}

export function redactAbsolutePaths(text: string): string {
  return text
    .replace(FILE_URI, (m) => basenameOf(m))
    .replace(WIN_ABS, (m) => basenameOf(m))
    .replace(UNC, (m) => basenameOf(m))
    .replace(POSIX_ABS, (m) => basenameOf(m));
}

export function redactOptional(text: string | undefined): string | undefined {
  return text === undefined ? undefined : redactAbsolutePaths(text);
}
