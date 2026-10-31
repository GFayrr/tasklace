import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  changelogSection,
  checksumsText,
  releaseNotes,
  releaseVersionOf,
  type FileFingerprint,
} from './release-files.ts';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const RELEASED_FILE = /^Tasklace-.+-(portable|setup)\.exe$/;
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

/** Checks that the tag names the version of the application, then writes the notes and the fingerprints of the release beside the built files, and tells continuous integration whether it is a pre-release. */
async function writeReleaseFiles(tag: string): Promise<void> {
  const release = releaseVersionOf(tag);
  if (release === null) {
    throw new Error(`The tag ${tag} does not name a version such as v1.2.3.`);
  }
  const packageFile: unknown = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const version: unknown = Reflect.get(Object(packageFile), 'version');
  if (version !== release.version) {
    throw new Error(
      `The tag ${tag} does not match the version ${String(version)} of package.json.`,
    );
  }
  const section = changelogSection(await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  if (section === null || section === '') {
    throw new Error(`CHANGELOG.md has no part for the version ${version}.`);
  }
  const names = (await readdir(DIST)).filter((name) => RELEASED_FILE.test(name));
  if (names.length !== 2) {
    throw new Error(
      `The release needs a portable executable and an installer, not ${names.join(', ')}.`,
    );
  }
  await writeFile(join(DIST, NOTES_FILE), releaseNotes(section, version));
  await writeFile(
    join(DIST, CHECKSUMS_FILE),
    checksumsText(await Promise.all(names.map(fingerprintOf))),
  );
  const output = process.env['GITHUB_OUTPUT'];
  if (output !== undefined) {
    await appendFile(output, `prerelease=${String(release.preRelease)}\n`);
  }
  console.log(`Wrote the notes and fingerprints of Tasklace ${version}.`);
}

await writeReleaseFiles(process.argv[2] ?? '');
