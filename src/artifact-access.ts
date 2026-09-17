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

// canonical 形は正規化済み絶対パス（スラッシュ区切り・ドライブレター小文字・`.`/`..` 解決）。
// repo-relative 化は行わない: 相対化の基準（cwd）は live と history で同値が保証されず
// （resume が record の cwd を書き潰す）、基準が揺れると同一ファイルの
// artifactId が経路ごとに割れる。
// symlink/junction の実体解決は行わない（history 経路ではファイルが既に存在しない場合があり、
// fs 解決を挟むと live と history で結果が割れる）。
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

// Windows はパスの大文字小文字を区別しないため、同一性判定（hash 入力）のみ小文字へ畳む。
// canonicalPath はドライブレター小文字化を除き原表記を保つ。
// 同一ファイル判定は必ず artifactId（case-folded）で行うこと — canonicalPath の
// 文字列比較は大小文字差で割れる（競合計算の前提）
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

// pp1 progress の wire 名。no-op ツールのため無効果として扱う。
// mcp__ 分岐より先に判定しないと unavailable に落ち、当該 Attempt が unknownEffects=true になって
// observed_data_dep 走査から丸ごと外れる（KNOWN_NO_EFFECT の例外集合への追加であり、input キー由来の分類規則は変えない）
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

// 分類規則: delegate はツール名（Agent/Task）、以降は input キー由来で
// 上から順に先着一致（write/read(path キー) → exec_unknown(command) → search(pattern) → other）。
// other の内訳はツール名で coverage を割り当てる（mcp__/未知 = unavailable・既知無効果 = complete）。
// 順序は load-bearing: command を持つ Write が corpus に1件実在し、
// exec 判定を先に置くとこの write が exec に化ける。
// delegate/search の coverage は complete（Agent 呼び出しや Glob/Grep を含む Attempt を unknownEffects=true にしない）
// （委任の効果は子イベントで観測される。search はファイル効果を持たない）。
// 前提: delegate=complete は子 transcript が同一 Attempt へ取り込まれて初めて成立する。
// 現状の history 合成は親 JSONL のみのため、footprint 導出の前に
// 子取り込みが必須 — この順序を破ると「委任のみの Attempt が
// unknownEffects=false かつ空 footprint」という偽の並列化可能判定を作る。
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

  // KNOWN 判定を mcp__ 判定より先に置く（progress wire は mcp__ 接頭辞を持つため。
  // 既存の KNOWN 名に mcp__ 接頭辞は無く、この順序入替で他ツールの分類は変わらない）
  if (KNOWN_NO_EFFECT_TOOLS.has(toolName)) {
    return { artifacts: [], effectCoverage: "complete", effectClass: "none" };
  }

  if (toolName.startsWith("mcp__")) {
    return { artifacts: [], effectCoverage: "unavailable", effectClass: "unknown" };
  }

  return { artifacts: [], effectCoverage: "unavailable", effectClass: "unknown" };
}
