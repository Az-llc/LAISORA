import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import { ANALYSIS_STORE_KEY, decodeAnalysisStore, type AnalysisStorage, type AnalysisStore } from "./analysis-persistence";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export function createAnalysisFileStorage(
  directory: string,
  log: (line: string) => void = () => {},
): AnalysisStorage {
  return {
    get: () => undefined,
    update: async () => {
      throw new Error("Analysis results are stored per session");
    },
    forSession(ownerId) {
      const sessionDirectory = path.join(directory, digest(ownerId));
      return {
        get(key) {
          if (key !== ANALYSIS_STORE_KEY) return undefined;
          const artifacts = new Map<string, unknown>();
          let names: string[];
          try { names = readdirSync(sessionDirectory); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") log("[analysis-store] cannot read analysis directory");
            names = [];
          }
          for (const name of names) {
            if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
            try {
              const artifact = JSON.parse(readFileSync(path.join(sessionDirectory, name), "utf8"));
              if (typeof artifact?.artifactId !== "string" || `${digest(artifact.artifactId)}.json` !== name) {
                log("[analysis-store] unreadable artifact file: identity mismatch (file retained)");
                continue;
              }
              const decoded = decodeAnalysisStore({ version: 1, sessions: { [ownerId]: { updatedAt: 0, artifacts: [artifact] } } }, log);
              const valid = decoded.sessions[ownerId]?.artifacts[0];
              if (valid) artifacts.set(valid.artifactId, valid);
            } catch (error) {
              log(error instanceof SyntaxError
                ? "[analysis-store] unreadable artifact file: invalid JSON (file retained)"
                : "[analysis-store] unreadable artifact file: read failed (file retained)");
            }
          }
          return { version: 1, sessions: { [ownerId]: {
            updatedAt: 0, artifacts: [...artifacts.values()],
          } } };
        },
        async update(key, value) {
          if (key !== ANALYSIS_STORE_KEY) throw new Error("Unexpected analysis storage key");
          const entry = (value as AnalysisStore).sessions[ownerId];
          await mkdir(sessionDirectory, { recursive: true });
          for (const artifact of entry.artifacts) {
            const target = path.join(sessionDirectory, `${digest(artifact.artifactId)}.json`);
            const contents = JSON.stringify(artifact);
            try { if (readFileSync(target, "utf8") === contents) continue; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            const temporary = `${target}.${randomUUID()}.tmp`;
            try {
              const handle = await open(temporary, "wx");
              try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
              finally { await handle.close(); }
              await rename(temporary, target);
            } finally {
              await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              });
            }
          }
        },
      };
    },
  };
}
