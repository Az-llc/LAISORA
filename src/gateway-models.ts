import type { HostToWebview, ModelInfo } from "./protocol";
import type { Session } from "./session";
import { extensionContext } from "./host-context";
import * as l10n from "@vscode/l10n";

export const ADDITIONAL_MODELS_KEY = "laisora.additionalClaudeModels.v1";
export const CLAUDE_VERSION_ID = /^claude-(?:opus|sonnet|haiku|fable)-\d+(?:-\d+)*(?:\[1m\])?$/;

export function additionalClaudeModelIds(): string[] {
  const value = extensionContext?.globalState?.get<unknown>(ADDITIONAL_MODELS_KEY);
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && CLAUDE_VERSION_ID.test(id)) : [];
}

export function splitModelVersions(models: ModelInfo[]): { current: ModelInfo[]; older: ModelInfo[] } {
  const version = (m: ModelInfo) => {
    const match = /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d{1,2})?)(?:-\d{8})?(?:\[1m\])?$/i.exec(m.id)
      ?? /\b(opus|sonnet|haiku|fable) (\d+(?:\.\d+)?)/i.exec(m.label);
    return match ? { family: match[1].toLowerCase(), parts: match[2].split(/[.-]/).map(Number) } : null;
  };
  const compare = (a: number[], b: number[]) => a[0] - b[0] || (a[1] ?? 0) - (b[1] ?? 0);
  const latest = new Map<string, number[]>();
  for (const model of models) {
    const v = version(model);
    if (v && (!latest.has(v.family) || compare(v.parts, latest.get(v.family)!) > 0)) latest.set(v.family, v.parts);
  }
  const older = models.filter((m) => {
    const v = version(m);
    return m.id.startsWith("claude-") && v && compare(v.parts, latest.get(v.family)!) < 0;
  });
  return { current: models.filter((m) => !older.includes(m)), older };
}

export function modelRowsForSession(
  discovered: readonly Pick<ModelInfo, "id" | "label" | "description" | "resolvedModel">[]
): ModelInfo[] {
  const seen = new Set<string>();
  const additional = additionalClaudeModelIds().map((id) => ({
    id,
    label: id.replace(/^claude-/, ""),
    description: l10n.t("Added by model ID. Availability depends on your Claude account."),
  }));
  const rows: ModelInfo[] = [...discovered, ...additional].filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  const olderIds = new Set([...splitModelVersions(rows).older.map((m) => m.id), ...additional.map((m) => m.id)]);
  return rows.map((m) => olderIds.has(m.id) ? { ...m, olderVersion: true } : m);
}

export function recomputeModelRows(s: Session): void {
  s.models = modelRowsForSession(s.discoveredModels);
}

export function modelsMessage(s: Session): HostToWebview {
  return { type: "models", tabId: s.tabId, models: s.models };
}
