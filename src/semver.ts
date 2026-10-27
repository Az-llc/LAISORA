export interface SemVer {
  core: [number, number, number];
  prerelease: string[];
}

export function parseSemVer(text: string | undefined): SemVer | undefined {
  const match = cliVersionNumber(text)?.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ? match[4].split(".") : [] };
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const numeric = (value: string) => /^\d+$/.test(value);
  if (numeric(a) && numeric(b)) return Number(a) - Number(b);
  if (numeric(a) !== numeric(b)) return numeric(a) ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length;
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const order = comparePrereleaseIdentifier(a.prerelease[i], b.prerelease[i]);
    if (order !== 0) return order;
  }
  return a.prerelease.length - b.prerelease.length;
}

export function cliVersionNumber(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.match(/\d+\.\d+\.\d+[^\s]*/)?.[0] ?? trimmed;
}
