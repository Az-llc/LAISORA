export const DEFAULT_SYSTEM_APP_EXTENSIONS = [".xlsx", ".xls", ".docx", ".doc", ".pptx", ".ppt", ".pdf"];

export const R_CNV_20_BLOCKED_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
  ".msi", ".msp", ".scr", ".lnk", ".url", ".reg", ".hta", ".cpl", ".jar", ".app", ".sh", ".command",
]);

export function normalizeSystemAppExtension(value: string): string | null {
  if (!/^\.?[a-z0-9_-]+$/i.test(value)) return null;
  const extension = `.${value.replace(/^\./, "").toLowerCase()}`;
  return R_CNV_20_BLOCKED_EXTENSIONS.has(extension) ? null : extension;
}

let invalidSystemAppExtensionsLogged = false;

export function systemAppExtensions(value: unknown, logInvalid?: () => void): string[] {
  const entries: unknown[] = Array.isArray(value) ? value : DEFAULT_SYSTEM_APP_EXTENSIONS;
  const normalized = entries.map((item) => typeof item === "string" ? normalizeSystemAppExtension(item) : null);
  if ((!Array.isArray(value) || normalized.includes(null)) && !invalidSystemAppExtensionsLogged && logInvalid) {
    invalidSystemAppExtensionsLogged = true;
    logInvalid();
  }
  return [...new Set(normalized.filter((item): item is string => item !== null))];
}

export function decideOpenMode(realPath: string, options: {
  isDirectory: boolean;
  inside: boolean;
  systemAppExtensions: readonly string[];
}): "text" | "system-app" | "reveal-folder" | "refuse" {
  const finalSegment = realPath.split(/[\\/]/).at(-1) ?? "";
  if (finalSegment.includes(":")) return "text";
  if (options.isDirectory) return options.inside ? "reveal-folder" : "refuse";
  if (!options.inside) return "text";
  const extension = /\.[^.\\/]+$/.exec(finalSegment.replace(/[. ]+$/, ""))?.[0].toLowerCase() ?? "";
  if (R_CNV_20_BLOCKED_EXTENSIONS.has(extension)) return "text";
  return options.systemAppExtensions.some((item) => item.toLowerCase() === extension) ? "system-app" : "text";
}
