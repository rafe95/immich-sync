/** Immich server versions: support range and comparison. */

export type Version = { major: number; minor: number; patch: number };

/** Oldest supported Immich version (structured search with filter + cursor arrived in v3.2). */
export const MIN_SUPPORTED: Version = { major: 3, minor: 2, patch: 0 };

/** Newest major.minor the engine has been tested against. Newer versions work but get a warning. */
export const TESTED_UP_TO: Version = { major: 3, minor: 3, patch: Number.MAX_SAFE_INTEGER };

export type VersionStatus = "supported" | "unsupported" | "untested";

export function formatVersion(v: Version): string {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function versionStatus(v: Version): VersionStatus {
  if (compareVersions(v, MIN_SUPPORTED) < 0) return "unsupported";
  if (compareVersions(v, TESTED_UP_TO) > 0) return "untested";
  return "supported";
}

/**
 * Warning shown before a step runs between two servers on different Immich versions.
 * Returns null when both run the same version.
 */
export function versionMismatchWarning(source: Version, target: Version): string | null {
  if (compareVersions(source, target) === 0) return null;
  return `Source and target run different Immich versions (source ${formatVersion(source)}, target ${formatVersion(target)}).`;
}
