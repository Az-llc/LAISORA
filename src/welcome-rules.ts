import { compareSemVer, parseSemVer, type SemVer } from "./semver";
import type { WelcomeTipMark } from "./protocol";
import type { WelcomeNewsItem } from "./welcome-content";

type WelcomeNewsByVersion = Readonly<Record<string, readonly WelcomeNewsItem[]>>;

export function releaseBaseVersion(version: string): string | undefined {
  return parseSemVer(version)?.core.join(".");
}

export function welcomeNewsVersion(running: string, news: WelcomeNewsByVersion, dismissed: string | undefined): string | undefined {
  const base = parseSemVer(releaseBaseVersion(running));
  if (base === undefined) return undefined;
  let newest: { version: string; parsed: SemVer } | undefined;
  for (const [version, items] of Object.entries(news)) {
    const parsed = parseSemVer(version);
    if (parsed === undefined || parsed.prerelease.length > 0 || items.length === 0 || compareSemVer(parsed, base) > 0) continue;
    if (newest === undefined || compareSemVer(parsed, newest.parsed) > 0) newest = { version, parsed };
  }
  return newest !== undefined && laterWelcomeVersion(newest.version, dismissed) ? newest.version : undefined;
}

export function laterWelcomeVersion(candidate: string, than: string | undefined): boolean {
  const parsed = parseSemVer(candidate);
  if (parsed === undefined) return false;
  const current = parseSemVer(than);
  return current === undefined || compareSemVer(parsed, current) > 0;
}

export function releaseNewsEntryMissing(version: string, news: WelcomeNewsByVersion): boolean {
  const base = releaseBaseVersion(version);
  return base === undefined || !Object.hasOwn(news, base);
}

export function nextWelcomeTip(last: WelcomeTipMark | undefined, ids: readonly string[]): WelcomeTipMark | undefined {
  if (ids.length === 0) return undefined;
  if (last === undefined) return { id: ids[0], index: 0 };
  const at = ids.indexOf(last.id);
  const index = at >= 0 ? (at + 1) % ids.length : last.index % ids.length;
  return { id: ids[index], index };
}
