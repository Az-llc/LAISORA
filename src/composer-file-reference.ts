import type { FileLinkPlatform } from "./file-link-target";

export type PathRoot = "drive" | "unc" | "posix" | "relative";

export function pathRootOf(path: string): PathRoot {
  if (/^[a-z]:\//i.test(path)) return "drive";
  if (path.startsWith("//")) return "unc";
  return path.startsWith("/") ? "posix" : "relative";
}

export function relativeInside(path: string, root: string): string | undefined {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (path.length <= prefix.length) return undefined;
  const head = path.slice(0, prefix.length);
  const caseless = pathRootOf(prefix) === "drive" || pathRootOf(prefix) === "unc";
  const inside = caseless ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
  return inside ? path.slice(prefix.length) : undefined;
}

function withForwardSlashes(path: string, platform: FileLinkPlatform): string {
  return platform.windows ? path.replace(/\\/g, "/") : path;
}

export function insideCwdReference(absolutePath: string, cwd: string, platform: FileLinkPlatform): string | undefined {
  return cwd === "" ? undefined : relativeInside(withForwardSlashes(absolutePath, platform), withForwardSlashes(cwd, platform));
}

export function composerFileReference(absolutePath: string, cwd: string, platform: FileLinkPlatform): string {
  return insideCwdReference(absolutePath, cwd, platform) ?? withForwardSlashes(absolutePath, platform);
}
