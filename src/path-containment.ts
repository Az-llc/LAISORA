import { basename, dirname, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";

export function expandHomePath(value: string): string { return value.replace(/^~(?=[\\/])|^\$HOME(?=[\\/])/i, homedir()); }

declare const realPathBrand: unique symbol;
export type RealPath = string & { readonly [realPathBrand]: true };

export function realPath(target: string): Promise<RealPath> {
  return realpath(target) as Promise<RealPath>;
}

export function pathIsInside(root: RealPath, target: RealPath): boolean {
  return lexicalPathIsInsideForEarlyRejectOnly(root, target);
}

export function lexicalPathIsInsideForEarlyRejectOnly(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + sep);
}

export type NearestRealPath = { readonly path: RealPath } | { readonly unresolved: "missing" | "error" };

export function resolveNearestRealPathSync(target: string): NearestRealPath {
  let current = resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return { path: (missing.length === 0 ? real : join(real, ...missing.reverse())) as RealPath };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return { unresolved: "error" };
      const parent = dirname(current);
      if (parent === current) return { unresolved: "missing" };
      missing.push(basename(current));
      current = parent;
    }
  }
}

export function realPathOrNearestSync(target: string): RealPath | null {
  const result = resolveNearestRealPathSync(target);
  return "path" in result ? result.path : null;
}
