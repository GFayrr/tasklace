import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  formatVersion,
  newestRelease,
  readVersion,
  type PublishedRelease,
  type Version,
} from './version';

/** Reads a version known to be valid, throwing otherwise. */
function version(text: string): Version {
  const read = readVersion(text);
  if (read === null) {
    throw new Error(`${text} is not a version.`);
  }
  return read;
}

/** Makes a published release of a version, marked as a pre-release on GitHub or not. */
function release(text: string, markedPreRelease = false): PublishedRelease {
  return { version: version(text), markedPreRelease };
}

const identifierArbitrary = fc.oneof(
  fc.integer({ min: 0, max: 999_999_999 }).map(String),
  fc.stringMatching(/^[0-9]{0,2}[a-z-][0-9a-z-]{0,4}$/),
);
const versionArbitrary = fc
  .record({
    major: fc.integer({ min: 0, max: 999_999_999 }),
    minor: fc.integer({ min: 0, max: 999_999_999 }),
    patch: fc.integer({ min: 0, max: 999_999_999 }),
    preRelease: fc.array(identifierArbitrary, { maxLength: 3 }),
  })
  .filter((generated) => formatVersion(generated).length <= 64);

describe('readVersion', () => {
  it('reads a version with or without a leading v, with or without a pre-release part', () => {
    expect(readVersion('0.1.0')).toEqual({ major: 0, minor: 1, patch: 0, preRelease: [] });
    expect(readVersion('v12.3.45')).toEqual({ major: 12, minor: 3, patch: 45, preRelease: [] });
    expect(readVersion('1.0.0-beta.11.x-y')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      preRelease: ['beta', '11', 'x-y'],
    });
  });

  it('refuses anything that is not a version of Semantic Versioning, and versions too long to be real', () => {
    for (const text of [
      '',
      '1',
      '1.0',
      '01.0.0',
      '1.00.0',
      '1.0.0-',
      '1.0.0-01',
      '1.0.0-beta..1',
      '1.0.0+build',
      'V1.0.0',
      ' 1.0.0',
      '1.0.0 ',
      '1.0.0-é',
      '1234567890.0.0',
      `1.0.0-${'a'.repeat(59)}`,
    ]) {
      expect(readVersion(text), text).toBeNull();
    }
    expect(readVersion(`1.0.0-${'a'.repeat(58)}`)?.preRelease).toEqual(['a'.repeat(58)]);
    expect(readVersion(100)).toBeNull();
    expect(readVersion(null)).toBeNull();
  });

  it('gives back the same version once written and read again', () => {
    fc.assert(
      fc.property(versionArbitrary, (generated) => {
        expect(readVersion(formatVersion(generated))).toEqual(generated);
      }),
    );
  });
});

describe('compareVersions', () => {
  it('follows the precedence given by Semantic Versioning', () => {
    const ordered = [
      '0.9.9',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.2.0',
      '2.0.0',
      '10.0.0',
    ].map(version);
    const sorted = [...ordered].reverse().sort(compareVersions);
    expect(sorted.map(formatVersion)).toEqual(ordered.map(formatVersion));
    expect(compareVersions(version('1.0.0-1'), version('1.0.0-a'))).toBe(-1);
    expect(compareVersions(version('1.0.0-a'), version('1.0.0-1'))).toBe(1);
    expect(compareVersions(version('v2.0.0'), version('2.0.0'))).toBe(0);
  });

  it('orders any versions consistently: antisymmetric and transitive', () => {
    fc.assert(
      fc.property(versionArbitrary, versionArbitrary, versionArbitrary, (first, second, third) => {
        expect(Math.sign(compareVersions(first, second))).toBe(
          -Math.sign(compareVersions(second, first)),
        );
        if (compareVersions(first, second) <= 0 && compareVersions(second, third) <= 0) {
          expect(compareVersions(first, third)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });
});

describe('newestRelease', () => {
  it('finds the newest release after the current version, whatever their order', () => {
    expect(
      newestRelease([release('1.1.0'), release('1.3.0'), release('1.2.0')], version('1.1.0')),
    ).toEqual(version('1.3.0'));
  });

  it('finds nothing when the current version is the latest or newer than every release', () => {
    expect(newestRelease([release('1.1.0'), release('1.0.0')], version('1.1.0'))).toBeNull();
    expect(newestRelease([release('1.1.0')], version('2.0.0'))).toBeNull();
    expect(newestRelease([], version('1.0.0'))).toBeNull();
  });

  it('counts pre-releases before version 1.0.0, whether GitHub marks them or their version says so', () => {
    expect(newestRelease([release('0.2.0', true)], version('0.1.0'))).toEqual(version('0.2.0'));
    expect(newestRelease([release('0.2.0-beta.1')], version('0.1.0'))).toEqual(
      version('0.2.0-beta.1'),
    );
  });

  it('leaves pre-releases out from version 1.0.0, unless a pre-release is in use', () => {
    const releases = [release('1.1.0'), release('1.2.0', true), release('1.3.0-beta.1')];
    expect(newestRelease(releases, version('1.0.0'))).toEqual(version('1.1.0'));
    expect(newestRelease(releases, version('1.0.0-rc.1'))).toEqual(version('1.3.0-beta.1'));
  });
});

describe('a version', () => {
  it('comes only from reading one, never from parts written by hand', () => {
    const parts = { major: 0, minor: 1, patch: 0, preRelease: [] };
    // @ts-expect-error parts written by hand are not a version read by readVersion
    const handWritten: Version = parts;
    expect(readVersion('0.1.0')).toEqual(handWritten);
  });
});
