export const DEFAULT_SYSTEM_APP_EXTENSIONS = [".xlsx", ".xls", ".docx", ".doc", ".pptx", ".ppt", ".pdf"];

export const R_CNV_20_BLOCKED_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
  ".msi", ".msp", ".scr", ".lnk", ".url", ".reg", ".hta", ".cpl", ".jar", ".app", ".sh", ".command",
]);

export function normalizeSystemAppExtension(value: string): string | null {
  // R-CNV-20: chips and settings must reject malformed and blocked extensions identically.
  if (!/^\.?[a-z0-9_-]+$/i.test(value)) return null;
  const extension = `.${value.replace(/^\./, "").toLowerCase()}`;
  return R_CNV_20_BLOCKED_EXTENSIONS.has(extension) ? null : extension;
}

let invalidSystemAppExtensionsLogged = false;

export function systemAppExtensions(value: unknown, logInvalid?: () => void): string[] {
  const entries: unknown[] = Array.isArray(value) ? value : DEFAULT_SYSTEM_APP_EXTENSIONS;
  const normalized = entries.map((item) => typeof item === "string" ? normalizeSystemAppExtension(item) : null);
  // R-CNV-20: report discarded settings once across file opens and Host echoes per activation.
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
  // R-CNV-20: ADS and outside links must never reach an OS handler, even when listed.
  const finalSegment = realPath.split(/[\\/]/).at(-1) ?? "";
  if (finalSegment.includes(":")) return "text";
  if (options.isDirectory) return options.inside ? "reveal-folder" : "refuse";
  if (!options.inside) return "text";
  const extension = /\.[^.\\/]+$/.exec(finalSegment.replace(/[. ]+$/, ""))?.[0].toLowerCase() ?? "";
  // R-CNV-20: a user-supplied list cannot enable executable or script handlers.
  if (R_CNV_20_BLOCKED_EXTENSIONS.has(extension)) return "text";
  return options.systemAppExtensions.some((item) => item.toLowerCase() === extension) ? "system-app" : "text";
}
