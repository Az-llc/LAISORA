import * as l10n from "@vscode/l10n";
import { accountErrorText, isAccountErrorReason } from "./account-error";
import type { ExternalDetection, ExternalModelsState } from "./orchestration-executors";
import type { ModelInfo } from "./protocol";

export function modelListStatusText(list: ExternalModelsState, detection: ExternalDetection): string {
  const reason = detection.state === "notInstalled" ? "not-installed"
    : list.state === "failed" ? list.reason : list.state === "ok" && list.refresh === "failed" ? list.refreshReason ?? "model-list-failed" : undefined;
  if (!reason) return "";
  const text = isAccountErrorReason(reason) ? accountErrorText(reason, "recheck", undefined)
    : reason === "not-installed" ? l10n.t("The CLI could not be found. Install it or check its path, then recheck.")
    : l10n.t("Could not fetch the latest model list");
  if (list.state !== "ok" || !list.fetchedAt) return text;
  const remembered = l10n.t("Could not fetch the latest list (showing the list from {0})", new Date(list.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }));
  return text === l10n.t("Could not fetch the latest model list") ? remembered : `${text} ${remembered}`;
}

export const EXTENDED_CONTEXT_SUFFIX = "[1m]";

export function hasExtendedContext(id: string, anyCase: boolean): boolean {
  const tail = id.slice(-EXTENDED_CONTEXT_SUFFIX.length);
  return id.length >= EXTENDED_CONTEXT_SUFFIX.length && (anyCase ? tail.toLowerCase() : tail) === EXTENDED_CONTEXT_SUFFIX;
}

export function withoutExtendedContext(id: string, anyCase: boolean): string {
  return hasExtendedContext(id, anyCase) ? id.slice(0, -EXTENDED_CONTEXT_SUFFIX.length) : id;
}

export const CLAUDE_MODEL_FAMILIES: readonly string[] = ["opus", "sonnet", "haiku", "fable"];

const CLAUDE_MODEL_ID = new RegExp(`^(claude)-(${CLAUDE_MODEL_FAMILIES.join("|")})-(\\d+(?:-\\d+)*?)(?:-(\\d{8}))?(\\[1m\\])?$`, "i");

export interface ClaudeModelParts {
  family: string;
  version: readonly string[];
  date?: string;
  extended: boolean;
  exactCase: boolean;
}

export function claudeModelParts(id: string): ClaudeModelParts | undefined {
  const match = CLAUDE_MODEL_ID.exec(id);
  if (!match) return undefined;
  const family = match[2].toLowerCase();
  return {
    family,
    version: match[3].split("-"),
    ...(match[4] === undefined ? {} : { date: match[4] }),
    extended: match[5] !== undefined,
    exactCase: match[1] === "claude" && match[2] === family && (match[5] === undefined || match[5] === EXTENDED_CONTEXT_SUFFIX),
  };
}

export function isMajorMinorVersion(parts: ClaudeModelParts): boolean {
  return parts.version.length <= 2 && parts.version.slice(1).every((part) => part.length <= 2);
}

function displayParts(id: string): { family: string; version: string } | undefined {
  const parts = claudeModelParts(id);
  return parts && { family: parts.family[0].toUpperCase() + parts.family.slice(1), version: parts.version.join(".") };
}

export function shortModelDisplayName(id: string): string {
  const parts = displayParts(id);
  return parts ? `${parts.family} ${parts.version}${hasExtendedContext(id, true) ? " (1M)" : ""}` : id;
}

type ModelNameRow = Pick<ModelInfo, "id" | "resolvedModel"> & { label?: string };

export function findModelRow<T extends ModelNameRow>(rows: readonly T[], value: string): T | undefined {
  const contextRow = (id: string): boolean => hasExtendedContext(id, true);
  return rows.find((m) => m.id === value)
    ?? rows.find((m) => m.id !== "default" && m.resolvedModel === value && (contextRow(value) || !contextRow(m.id)));
}

export function resolveModelDisplayName(rows: readonly ModelNameRow[], model: string | undefined): string | undefined {
  const value = model?.trim();
  if (!value) return undefined;
  const label = findModelRow(rows, value)?.label;
  return label && label !== value ? label : shortModelDisplayName(value);
}

export function modelLabelWithVersion(displayName: string | undefined, id: string, resolvedModel?: string): string {
  if (!displayName || displayName === id) return shortModelDisplayName(resolvedModel || id);
  const parts = displayParts(resolvedModel || id);
  if (!parts) return displayName;
  const { family, version } = parts;
  const namedFamily = new RegExp(`\\b${family}\\b(?!\\s+\\d)`, "i");
  const namedVersion = new RegExp(`\\b${family}\\s+(\\d+(?:\\.\\d+)*)\\b`, "i").exec(displayName);
  if (namedVersion) return namedVersion[1] === version ? displayName : shortModelDisplayName(resolvedModel || id);
  if (namedFamily.test(displayName)) return displayName.replace(namedFamily, (name) => `${name} ${version}`);
  if (id === "default") return `${displayName} — ${family} ${version}`;
  return displayName;
}

export function modelsLoadingText(): string {
  return l10n.t("Loading models. This may take a few seconds after starting a conversation.");
}
