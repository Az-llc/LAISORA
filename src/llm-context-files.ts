import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-env";
import { redactAbsolutePaths } from "./path-redaction";
import * as l10n from "@vscode/l10n";

export const CONTEXT_FILE_CHAR_CAP = 12_000;

export interface ContextFile {
  id: string;
  path: string;
  bytes: number;
  text: string;
  truncated?: boolean;
  originalBytes?: number;
}

export function escapeReferenceContent(content: string): string {
  return content.replace(/<\/reference/gi, "&lt;/reference");
}

export function renderReferenceEnvelope(file: ContextFile): string {
  if (file.truncated) {
    return `<reference id="${file.id}" path="${file.path}" bytes="${file.bytes}" truncated="true" originalBytes="${file.originalBytes ?? file.bytes}">\n${file.text}\n${l10n.t("[… truncated beyond this point …]")}\n</reference>`;
  }
  return `<reference id="${file.id}" path="${file.path}" bytes="${file.bytes}">\n${file.text}\n</reference>`;
}

export function slugForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function safeReadFile(filePath: string, displayPath: string, id: string): ContextFile | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const stat = statSync(filePath);
    if (!stat.isFile()) return undefined;
    const raw = readFileSync(filePath, "utf8");
    const isTruncated = raw.length > CONTEXT_FILE_CHAR_CAP;
    const capped = isTruncated ? raw.slice(0, CONTEXT_FILE_CHAR_CAP) : raw;
    const redacted = redactAbsolutePaths(capped);
    const escaped = escapeReferenceContent(redacted);
    const bytes = Buffer.byteLength(escaped, "utf8");
    const originalBytes = Buffer.byteLength(raw, "utf8");
    return {
      id,
      path: displayPath,
      bytes,
      text: escaped,
      ...(isTruncated ? { truncated: true, originalBytes } : {}),
    };
  } catch {
    return undefined;
  }
}


export function loadContextFiles(cwd: string, configDir: string = claudeConfigDir()): ContextFile[] {
  const files: ContextFile[] = [];
  let fileIndex = 1;

  const tryAdd = (absolutePath: string, displayPath: string): void => {
    const file = safeReadFile(absolutePath, displayPath, `F${fileIndex}`);
    if (file !== undefined) {
      files.push(file);
      fileIndex++;
    }
  };

  tryAdd(join(cwd, "CLAUDE.md"), "CLAUDE.md");

  const projectRulesDir = join(cwd, ".claude", "rules");
  if (existsSync(projectRulesDir)) {
    try {
      const entries = readdirSync(projectRulesDir).sort();
      for (const entry of entries) {
        if (entry.endsWith(".md")) {
          tryAdd(join(projectRulesDir, entry), `.claude/rules/${entry}`);
        }
      }
    } catch {}
  }

  const label = process.env.CLAUDE_CONFIG_DIR ? "$CLAUDE_CONFIG_DIR" : "~/.claude";

  tryAdd(join(configDir, "CLAUDE.md"), `${label}/CLAUDE.md`);

  const userRulesDir = join(configDir, "rules");
  if (existsSync(userRulesDir)) {
    try {
      const entries = readdirSync(userRulesDir).sort();
      for (const entry of entries) {
        if (entry.endsWith(".md")) {
          tryAdd(join(userRulesDir, entry), `${label}/rules/${entry}`);
        }
      }
    } catch {}
  }

  const slug = slugForCwd(cwd);
  const memoryPath = join(configDir, "projects", slug, "memory", "MEMORY.md");
  tryAdd(memoryPath, `${label}/projects/${slug}/memory/MEMORY.md`);

  return files;
}
