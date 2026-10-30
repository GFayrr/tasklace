import { MAX_VERSION_LENGTH } from './limits';

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly preRelease: readonly string[];
}

export interface PublishedRelease {
  readonly version: Version;
  readonly markedPreRelease: boolean;
}

const NUMBER = String.raw`0|[1-9]\d{0,8}`;
const IDENTIFIER = String.raw`(?:${NUMBER}|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const VERSION = new RegExp(
  String.raw`^v?(${NUMBER})\.(${NUMBER})\.(${NUMBER})(?:-(${IDENTIFIER}(?:\.${IDENTIFIER})*))?$`,
);
const NUMERIC_IDENTIFIER = /^\d+$/;
const FIRST_STABLE_MAJOR = 1;

/** Reads a version written the way of Semantic Versioning 2.0, with or without a leading “v” and without build metadata, or returns null for any other value. */
export function readVersion(value: unknown): Version | null {
  if (typeof value !== 'string' || value.length > MAX_VERSION_LENGTH) {
    return null;
  }
  const match = VERSION.exec(value);
  if (match === null) {
    return null;
  }
  const [, major = '', minor = '', patch = '', preRelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    preRelease: preRelease === undefined ? [] : preRelease.split('.'),
  };
}

/** Writes a version as Semantic Versioning does, without a leading “v”. */
export function formatVersion(version: Version): string {
  const core = `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
  return version.preRelease.length === 0 ? core : `${core}-${version.preRelease.join('.')}`;
}

/** Compares two versions by the precedence of Semantic Versioning, returning a negative number when the first comes before the second, zero when they are equal and a positive number otherwise. */
export function compareVersions(first: Version, second: Version): number {
  const core =
    first.major - second.major || first.minor - second.minor || first.patch - second.patch;
  return core === 0 ? comparePreReleases(first.preRelease, second.preRelease) : Math.sign(core);
}

/** Compares the pre-release parts of two versions of the same core, a version without one coming after every version with one. */
function comparePreReleases(first: readonly string[], second: readonly string[]): number {
  if (first.length === 0 || second.length === 0) {
    return Math.sign(second.length - first.length);
  }
  const shared = Math.min(first.length, second.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareIdentifiers(first[index] ?? '', second[index] ?? '');
    if (order !== 0) {
      return order;
    }
  }
  return Math.sign(first.length - second.length);
}

/** Compares two identifiers of a pre-release part: numbers by value and before words, words by their characters. */
function compareIdentifiers(first: string, second: string): number {
  const firstIsNumber = NUMERIC_IDENTIFIER.test(first);
  const secondIsNumber = NUMERIC_IDENTIFIER.test(second);
  if (firstIsNumber && secondIsNumber) {
    return Math.sign(Number(first) - Number(second));
  }
  if (firstIsNumber !== secondIsNumber) {
    return firstIsNumber ? -1 : 1;
  }
  return first < second ? -1 : first > second ? 1 : 0;
}

/** Finds the newest published release after the current version, counting releases marked as pre-releases only before version 1.0.0 or while a pre-release is in use, or returns null when the current version is the latest. */
export function newestRelease(
  releases: readonly PublishedRelease[],
  current: Version,
): Version | null {
  const takesPreReleases = current.major < FIRST_STABLE_MAJOR || current.preRelease.length > 0;
  let newest: Version | null = null;
  for (const { version, markedPreRelease } of releases) {
    const isPreRelease = markedPreRelease || version.preRelease.length > 0;
    const counts = takesPreReleases || !isPreRelease;
    if (counts && compareVersions(version, newest ?? current) > 0) {
      newest = version;
    }
  }
  return newest;
}
