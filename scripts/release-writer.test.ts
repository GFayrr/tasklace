import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeReleaseFiles } from './release-writer.ts';

const VERSION = '0.2.0';
const FILES = [
  `Tasklace-${VERSION}-amd64.deb`,
  `Tasklace-${VERSION}-portable.exe`,
  `Tasklace-${VERSION}-setup.exe`,
];
const CHANGELOG = `# Changelog\n\n## [${VERSION}] - 2026-12-01\n\n- A change.\n`;

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tasklace-release-'));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: VERSION }));
  await writeFile(join(root, 'CHANGELOG.md'), CHANGELOG);
  await Promise.all(FILES.map((name) => writeFile(join(root, 'dist', name), name)));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Gives the SHA-256 fingerprint of a text. */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('writeReleaseFiles', () => {
  it('writes the notes and fingerprints of a release beside its files and marks a preview as a pre-release', async () => {
    const output = join(root, 'output');
    expect(await writeReleaseFiles(root, `v${VERSION}`, output)).toBe(VERSION);
    const checksums = await readFile(join(root, 'dist', 'SHA256SUMS.txt'), 'utf8');
    expect(checksums.trimEnd().split('\n')).toEqual(
      FILES.map((name) => `${sha256(name)}  ${name}`),
    );
    expect((await readFile(join(root, 'dist', 'release-notes.md'), 'utf8')).split('\n')[0]).toBe(
      '- A change.',
    );
    expect(await readFile(output, 'utf8')).toBe('prerelease=true\n');
  });

  it('writes no output when continuous integration gives no file for it', async () => {
    expect(await writeReleaseFiles(root, `v${VERSION}`, undefined)).toBe(VERSION);
    expect((await readdir(root)).sort()).toEqual(['CHANGELOG.md', 'dist', 'package.json']);
  });

  it.skipIf(process.platform === 'win32')(
    'writes fingerprints that the command given to people accepts',
    async () => {
      await writeReleaseFiles(root, `v${VERSION}`, undefined);
      const answer = execFileSync('sha256sum', ['--check', '--ignore-missing', 'SHA256SUMS.txt'], {
        cwd: join(root, 'dist'),
        encoding: 'utf8',
      });
      expect(answer.trimEnd().split('\n')).toEqual(FILES.map((name) => `${name}: OK`));
    },
  );

  it('writes nothing for a tag that does not match the application', async () => {
    await expect(writeReleaseFiles(root, 'v0.3.0', undefined)).rejects.toThrow();
    await expect(readFile(join(root, 'dist', 'SHA256SUMS.txt'))).rejects.toThrow('ENOENT');
  });
});
