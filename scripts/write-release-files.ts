import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkRelease, checksumsText, type FileFingerprint } from './release-files.ts';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const NOTES_FILE = 'release-notes.md';
const CHECKSUMS_FILE = 'SHA256SUMS.txt';

/** Computes the SHA-256 fingerprint of a file, reading it in pieces. */
async function fingerprintOf(name: string): Promise<FileFingerprint> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(DIST, name))) {
    hash.update(chunk as Buffer);
  }
  return { name, sha256: hash.digest('hex') };
}

/** Checks the release a tag names against the application, its changelog and its built files, then writes its notes and the fingerprints of its files beside them, and tells continuous integration whether it is a pre-release. */
async function writeReleaseFiles(tag: string): Promise<void> {
  const packageFile: unknown = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const release = checkRelease(
    tag,
    Reflect.get(Object(packageFile), 'version'),
    await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8'),
    await readdir(DIST),
  );
  await writeFile(join(DIST, NOTES_FILE), release.notes);
  await writeFile(
    join(DIST, CHECKSUMS_FILE),
    checksumsText(await Promise.all(release.files.map(fingerprintOf))),
  );
  const output = process.env['GITHUB_OUTPUT'];
  if (output !== undefined) {
    await appendFile(output, `prerelease=${String(release.preRelease)}\n`);
  }
  console.log(`Wrote the notes and fingerprints of Tasklace ${release.version}.`);
}

await writeReleaseFiles(process.argv[2] ?? '');
