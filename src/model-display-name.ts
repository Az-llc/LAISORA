// SDK 0.3.257 実測: claude-fable-5[1m] と claude-fable-5-1[1m] の両方が displayName "Fable" を返す。
// 版は resolvedModel / id から補う。R-CMD-02: [1m] は文脈長で版ではない。最新版の表を持たない。
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
