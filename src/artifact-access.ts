import { createHash } from "node:crypto";

export type ArtifactMode = "read" | "write" | "exec" | "unknown";

export type EffectCoverage = "complete" | "partial" | "unavailable";

export type EffectClass = "delegate" | "write" | "read" | "exec_unknown" | "search" | "none" | "unknown";

export interface HostArtifactAccess {
  canonicalPath: string;
  artifactId: string;
  mode: ArtifactMode;
}

export interface ProjectedArtifactAccess {
  artifactId: string;
  displayName?: string;
  mode: ArtifactMode;
}

interface ParsedPath {
  root: string;
  isAbsolute: boolean;
  segments: string[];
}

function resolveSegments(rawSegments: string[], allowLeadingParent: boolean): string[] {
  const segments: string[] = [];
  for (const seg of rawSegments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (allowLeadingParent) {
        segments.push("..");
      }
    } else {
      segments.push(seg);
    }
  }
  return segments;
}

function parsePath(p: string): ParsedPath {
  const normalized = p.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([a-zA-Z]):(?:\/(.*)|(.*))?$/);
  if (driveMatch) {
    const rest = driveMatch[2] ?? driveMatch[3] ?? "";
    return {
      root: `${driveMatch[1].toLowerCase()}:/`,
      isAbsolute: true,
      segments: resolveSegments(rest.split("/"), false),
    };
  }
  if (normalized.startsWith("//")) {
    return {
      root: "//",
      isAbsolute: true,
      segments: resolveSegments(normalized.slice(2).split("/"), false),
    };
  }
  if (normalized.startsWith("/")) {
    return {
      root: "/",
      isAbsolute: true,
      segments: resolveSegments(normalized.split("/"), false),
    };
  }
  return {
    root: "",
    isAbsolute: false,
    segments: resolveSegments(normalized.split("/"), true),
  };
}

export function canonicalizeArtifactPath(rawPath: string, baseDir: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) return "";
  const parsed = parsePath(trimmed);
  if (parsed.isAbsolute) {
    return parsed.root + parsed.segments.join("/");
  }
  const base = baseDir.trim().length > 0 ? parsePath(baseDir) : null;
  if (base && base.isAbsolute) {
    const combined = resolveSegments([...base.segments, ...parsed.segments], false);
    return base.root + combined.join("/");
  }
  return parsed.segments.join("/");
}

export function artifactIdOf(canonicalPath: string): string {
  return createHash("sha256").update(canonicalPath.toLowerCase(), "utf8").digest("hex").slice(0, 16);
}

export function projectArtifactAccess(host: HostArtifactAccess): ProjectedArtifactAccess {
  const segments = host.canonicalPath.split("/").filter((s) => s.length > 0);
  const displayName = segments.length > 0 ? segments[segments.length - 1] : undefined;
  const projected: ProjectedArtifactAccess = {
    artifactId: host.artifactId,
    mode: host.mode,
  };
  if (displayName !== undefined) {
    projected.displayName = displayName;
  }
  return projected;
}

export const PROGRESS_WIRE_TOOL_NAME = "mcp__laisora_progress__progress";

const KNOWN_NO_EFFECT_TOOLS = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "ToolSearch",
  "ExitPlanMode",
  "AskUserQuestion",
  PROGRESS_WIRE_TOOL_NAME,
]);

export interface ArtifactExtraction {
  artifacts: HostArtifactAccess[];
  effectCoverage: EffectCoverage;
  effectClass: EffectClass;
}

export function extractArtifactAccesses(
  toolName: string,
  input: Record<string, unknown> | undefined,
  baseDir: string
): ArtifactExtraction {
  if (toolName === "Agent" || toolName === "Task") {
    return { artifacts: [], effectCoverage: "complete", effectClass: "delegate" };
  }

  if (input !== undefined && ("file_path" in input || "notebook_path" in input)) {
    const isWrite = "content" in input || "new_string" in input || "edits" in input;
    const rawPath =
      typeof input.file_path === "string" && input.file_path.trim().length > 0
        ? input.file_path
        : typeof input.notebook_path === "string" && input.notebook_path.trim().length > 0
          ? input.notebook_path
          : undefined;
    if (rawPath === undefined) {
      return { artifacts: [], effectCoverage: "partial", effectClass: isWrite ? "write" : "read" };
    }
    const canonicalPath = canonicalizeArtifactPath(rawPath, baseDir);
    return {
      artifacts: [
        { canonicalPath, artifactId: artifactIdOf(canonicalPath), mode: isWrite ? "write" : "read" },
      ],
      effectCoverage: "complete",
      effectClass: isWrite ? "write" : "read",
    };
  }

  if (input !== undefined && "command" in input) {
    return { artifacts: [], effectCoverage: "partial", effectClass: "exec_unknown" };
  }

  if (input !== undefined && "pattern" in input) {
    return { artifacts: [], effectCoverage: "complete", effectClass: "search" };
  }

  if (KNOWN_NO_EFFECT_TOOLS.has(toolName)) {
    return { artifacts: [], effectCoverage: "complete", effectClass: "none" };
  }

  if (toolName.startsWith("mcp__")) {
    return { artifacts: [], effectCoverage: "unavailable", effectClass: "unknown" };
  }

  return { artifacts: [], effectCoverage: "unavailable", effectClass: "unknown" };
}
