/** The command's package and version as npm publishes them. */
import packageJson from "../../package.json" with { type: "json" };

export const PACKAGE_NAME = "superbot-cli";
export const CLI_VERSION: string = packageJson.version;

type Parsed = { core: [number, number, number]; prerelease: string[] };

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(version: string): Parsed | undefined {
  const match = SEMVER.exec(version.trim());
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function isVersion(version: string): boolean {
  return parse(version) !== undefined;
}

function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Math.sign(Number(a) - Number(b));
  // A numeric identifier sorts before an alphanumeric one.
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semantic version precedence: negative when `a` is older than `b`, positive when newer, zero when
 * equal. A prerelease sorts before its release; build metadata is ignored. Undefined when either
 * is not a version.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const difference = Math.sign(left.core[index]! - right.core[index]!);
    if (difference !== 0) return difference;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = left.prerelease[index];
    const y = right.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const difference = compareIdentifiers(x, y);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether `latest` is a newer version than `current`; false when either is not a version. */
export function isNewer(latest: string, current: string): boolean {
  return (compareVersions(latest, current) ?? 0) > 0;
}
