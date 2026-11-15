import { chmodSync, lstatSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { retryTransientSync } from "./transient-fs";

const LINK_CHAIN_MAX = 40;

function linkChainEnd(file: string): string {
  try {
    return realpathSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw e;
  }
  let current = file;
  for (let step = 0; step < LINK_CHAIN_MAX; step++) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink() !== true) return current;
    current = resolve(realpathSync(dirname(current)), readlinkSync(current));
  }
  throw Object.assign(new Error(`too many symbolic links: ${file}`), { code: "ELOOP" });
}

function tmpPathNotSharedWithOtherWindows(file: string): string {
  return `${file}.laisora.${process.pid}.tmp`;
}

export function replaceFileThroughLinks(file: string, text: string): void {
  const target = linkChainEnd(file);
  const tmp = tmpPathNotSharedWithOtherWindows(target);
  try {
    retryTransientSync(() => {
      writeFileSync(tmp, text, "utf8");
      const mode = statSync(target, { throwIfNoEntry: false })?.mode;
      if (mode !== undefined && process.platform !== "win32") chmodSync(tmp, mode & 0o7777);
      renameSync(tmp, target);
    });
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
    }
    throw e;
  }
}
