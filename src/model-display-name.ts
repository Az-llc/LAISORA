import * as l10n from "@vscode/l10n";
import type { ExternalDetection, ExternalModelsState } from "./orchestration-executors";
import type { ModelInfo } from "./protocol";

export function modelListStatusText(list: ExternalModelsState, detection: ExternalDetection): string {
  const reason = detection.state === "notInstalled" ? "not-installed"
    : list.state === "failed" ? list.reason : list.state === "ok" && list.refresh === "failed" ? list.refreshReason ?? "model-list-failed" : undefined;
  if (!reason) return "";
  let text: string;
  switch (reason) {
    case "authentication-required": text = l10n.t("Sign-in is required. Log in using the CLI, then recheck."); break;
    case "organization-not-allowed": text = l10n.t("This organization is not allowed. Check your CLI account, then recheck."); break;
    case "account-on-hold": text = l10n.t("This account is on hold. Check your account, then recheck."); break;
    case "verification-required": text = l10n.t("Account verification is required. Verify your account, then recheck."); break;
    case "billing-error": text = l10n.t("There is an account billing problem. Check your subscription or billing settings, then recheck."); break;
    case "not-installed": text = l10n.t("The CLI could not be found. Install it or check its path, then recheck."); break;
    default: text = l10n.t("Could not fetch the latest model list");
  }
  if (list.state !== "ok" || !list.fetchedAt) return text;
  const remembered = l10n.t("Could not fetch the latest list (showing the list from {0})", new Date(list.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }));
  return text === l10n.t("Could not fetch the latest model list") ? remembered : `${text} ${remembered}`;
}

function claudeModelParts(id: string): { family: string; version: string } | undefined {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*?)(?:-\d{8})?(?:\[1m\])?$/i.exec(id);
  if (!match) return undefined;
  const family = match[1].toLowerCase();
  return { family: family[0].toUpperCase() + family.slice(1), version: match[2].replace(/-/g, ".") };
}

export function shortModelDisplayName(id: string): string {
  const parts = claudeModelParts(id);
  return parts ? `${parts.family} ${parts.version}${/\[1m\]$/i.test(id) ? " (1M)" : ""}` : id;
}

type ModelNameRow = Pick<ModelInfo, "id" | "resolvedModel"> & { label?: string };

export function findModelRow<T extends ModelNameRow>(rows: readonly T[], value: string): T | undefined {
  const contextRow = (id: string): boolean => /\[1m\]$/i.test(id);
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
  const parts = claudeModelParts(resolvedModel || id);
  if (!parts) return displayName;
  const { family, version } = parts;
  const namedFamily = new RegExp(`\\b${family}\\b(?!\\s+\\d)`, "i");
  const namedVersion = new RegExp(`\\b${family}\\s+(\\d+(?:\\.\\d+)*)\\b`, "i").exec(displayName);
  if (namedVersion) return namedVersion[1] === version ? displayName : shortModelDisplayName(resolvedModel || id);
  if (namedFamily.test(displayName)) return displayName.replace(namedFamily, (name) => `${name} ${version}`);
  if (id === "default") return `${displayName} — ${family} ${version}`;
  return displayName;
}
