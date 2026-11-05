import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkRelease, checksumsText, type FileFingerprint } from './release-files.ts';

const NOTES_FILE = 'release-notes.md';
const CHECKSUMS_FILE = 'SHA256SUMS.txt';

/** Computes the SHA-256 fingerprint of a file, reading it in pieces. */
async function fingerprintOf(folder: string, name: string): Promise<FileFingerprint> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(folder, name))) {
    hash.update(chunk as Buffer);
  }
  return { name, sha256: hash.digest('hex') };
}

/** Checks the release a tag names against the application, its changelog and its built files, then writes its notes and fingerprints beside them, tells continuous integration whether it is a pre-release, and gives its version. */
export async function writeReleaseFiles(
  root: string,
  tag: string,
  outputFile: string | undefined,
): Promise<string> {
  const dist = join(root, 'dist');
  const packageFile: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const release = checkRelease(
    tag,
    Reflect.get(Object(packageFile), 'version'),
    await readFile(join(root, 'CHANGELOG.md'), 'utf8'),
    await readdir(dist),
  );
  await writeFile(join(dist, NOTES_FILE), release.notes);
  const fingerprints = release.files.map((name) => fingerprintOf(dist, name));
  await writeFile(join(dist, CHECKSUMS_FILE), checksumsText(await Promise.all(fingerprints)));
  if (outputFile !== undefined) {
    await appendFile(outputFile, `prerelease=${String(release.preRelease)}\n`);
  }
  return release.version;
}
