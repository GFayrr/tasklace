import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readVersion } from '../src/core/version';
import {
  changelogSection,
  checkRelease,
  checksumsText,
  releaseNotes,
  releaseVersionOf,
} from './release-files.ts';

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '- Not yet.',
  '',
  '## [0.2.0] - 2026-12-01',
  '',
  '### Added',
  '',
  '- Signed executables.',
  '',
  '## [0.1.0] - 2026-11-02',
  '',
  '### Added',
  '',
  '- The first preview.',
  '',
  '[0.1.0]: https://github.com/GFayrr/tasklace/releases/tag/v0.1.0',
].join('\r\n');

describe('releaseVersionOf', () => {
  it('reads the version of a tag, a pre-release before 1.0.0 or with a pre-release part', () => {
    expect(['v0.1.0', 'v1.0.0', 'v1.2.3-beta.1', 'v10.20.30'].map(releaseVersionOf)).toEqual([
      { version: '0.1.0', preRelease: true },
      { version: '1.0.0', preRelease: false },
      { version: '1.2.3-beta.1', preRelease: true },
      { version: '10.20.30', preRelease: false },
    ]);
  });

  it('refuses a tag that is not a version', () => {
    for (const tag of [
      '0.1.0',
      'v0.1',
      'v0.1.0.1',
      'release-1',
      'v1.2.3-',
      'v1.2.3 ',
      'v01.2.3',
      'v1.2.3-a..b',
      'v1.2.3-01',
      'v1234567890.0.0',
      `v1.2.3-${'a'.repeat(60)}`,
    ]) {
      expect(releaseVersionOf(tag), tag).toBeNull();
    }
  });
});

describe('changelogSection', () => {
  it('gives the part of a version up to the next part, or to the end', () => {
    expect(changelogSection(CHANGELOG, '0.2.0')).toBe('### Added\n\n- Signed executables.');
    expect(changelogSection(CHANGELOG, '0.1.0')).toBe(
      '### Added\n\n- The first preview.\n\n[0.1.0]: https://github.com/GFayrr/tasklace/releases/tag/v0.1.0',
    );
    expect(changelogSection(CHANGELOG, 'Unreleased')).toBe('- Not yet.');
  });

  it('gives null for a version the changelog does not have', () => {
    expect(changelogSection(CHANGELOG, '0.3.0')).toBeNull();
    expect(changelogSection(CHANGELOG, '0.1')).toBeNull();
  });
});

describe('releaseNotes', () => {
  it('follows the part of the changelog with the files of the release and why it is not signed', () => {
    expect(releaseNotes('- The first preview.', '0.1.0')).toBe(
      [
        '- The first preview.',
        '',
        '### Files',
        '',
        '- `Tasklace-0.1.0-portable.exe` runs with a double-click, with nothing to install.',
        '- `Tasklace-0.1.0-setup.exe` installs Tasklace for your account, without administrator rights.',
        '- `SHA256SUMS.txt` gives the fingerprint of each file, to compare with `Get-FileHash <file> -Algorithm SHA256`.',
        '',
        'This version is not signed: Windows warns before running it, and does not run it at all while Smart App Control is on. The [code signing policy](https://github.com/GFayrr/tasklace#code-signing-policy) tells why and what comes next.',
        '',
      ].join('\n'),
    );
  });
});

describe('checksumsText', () => {
  it('writes one fingerprint a line, as sha256sum does, in the order of the names', () => {
    expect(
      checksumsText([
        { name: 'Tasklace-0.1.0-setup.exe', sha256: 'b'.repeat(64) },
        { name: 'Tasklace-0.1.0-portable.exe', sha256: 'a'.repeat(64) },
      ]),
    ).toBe(
      `${'a'.repeat(64)}  Tasklace-0.1.0-portable.exe\n${'b'.repeat(64)}  Tasklace-0.1.0-setup.exe\n`,
    );
    expect(checksumsText([])).toBe('');
  });
});

describe('the tags a release accepts', () => {
  it('are exactly the versions Tasklace reads from its releases, with their leading v', () => {
    const piece = fc.constantFrom(
      '0',
      '1',
      '9',
      '01',
      '10',
      'a',
      'A',
      '-',
      '.',
      'v',
      ' ',
      '1234567890',
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 40 }), (pieces) => {
        const tag = `v${pieces.join('')}`;
        expect(releaseVersionOf(tag) !== null).toBe(readVersion(tag) !== null);
      }),
      { numRuns: 2_000 },
    );
    for (const tag of ['v0.1.0', 'v1.2.3-rc.1', 'v1.2.3-0a', `v1.2.3-${'a'.repeat(57)}`]) {
      expect([releaseVersionOf(tag) !== null, readVersion(tag) !== null], tag).toEqual([
        true,
        true,
      ]);
    }
  });
});

describe('checkRelease', () => {
  const built = ['Tasklace-0.1.0-portable.exe', 'Tasklace-0.1.0-setup.exe', 'win-unpacked'];

  it('gives the version, its kind, its notes and exactly its two executables', () => {
    expect(checkRelease('v0.1.0', '0.1.0', CHANGELOG, built)).toEqual({
      version: '0.1.0',
      preRelease: true,
      notes: releaseNotes(
        '### Added\n\n- The first preview.\n\n[0.1.0]: https://github.com/GFayrr/tasklace/releases/tag/v0.1.0',
        '0.1.0',
      ),
      files: ['Tasklace-0.1.0-portable.exe', 'Tasklace-0.1.0-setup.exe'],
    });
  });

  it('refuses a tag that is not a version or not that of the application, a version without its part of the changelog, and missing executables', () => {
    expect(() => checkRelease('0.1.0', '0.1.0', CHANGELOG, built)).toThrow(
      'The tag 0.1.0 does not name a version such as v1.2.3.',
    );
    expect(() => checkRelease('v0.2.0', '0.1.0', CHANGELOG, built)).toThrow(
      'The tag v0.2.0 does not match the version 0.1.0 of package.json.',
    );
    expect(() => checkRelease('v0.3.0', '0.3.0', CHANGELOG, built)).toThrow(
      'CHANGELOG.md has no part for the version 0.3.0.',
    );
    expect(() => checkRelease('v0.4.0', '0.4.0', '## [0.4.0]\n\n## [0.3.0]', built)).toThrow(
      'CHANGELOG.md has no part for the version 0.4.0.',
    );
    expect(() =>
      checkRelease('v0.1.0', '0.1.0', CHANGELOG, [
        'Tasklace-0.0.9-setup.exe',
        'Tasklace-0.1.0-setup.exe',
      ]),
    ).toThrow('The release needs Tasklace-0.1.0-portable.exe, which the build did not make.');
    expect(() => checkRelease('v0.1.0', '0.1.0', CHANGELOG, [])).toThrow(
      'The release needs Tasklace-0.1.0-portable.exe and Tasklace-0.1.0-setup.exe, which the build did not make.',
    );
  });
});
