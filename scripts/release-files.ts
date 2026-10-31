const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
const SECTION_START = /^## \[(.+?)\]/;
const SIGNATURE_NOTE = [
  '### Files',
  '',
  '- `Tasklace-{version}-portable.exe` runs with a double-click, with nothing to install.',
  '- `Tasklace-{version}-setup.exe` installs Tasklace for your account only.',
  '- `SHA256SUMS.txt` gives the fingerprint of each file, to compare with `Get-FileHash <file> -Algorithm SHA256`.',
  '',
  'This version is not signed: Windows warns before running it, and does not run it at all while Smart App Control is on. The [code signing policy](https://github.com/GFayrr/tasklace#code-signing-policy) tells why and what comes next.',
].join('\n');

export interface ReleaseVersion {
  readonly version: string;
  readonly preRelease: boolean;
}

export interface FileFingerprint {
  readonly name: string;
  readonly sha256: string;
}

/** Reads the version a release tag names, a pre-release being any version before 1.0.0 or with a pre-release part, or returns null for a tag that is not a version. */
export function releaseVersionOf(tag: string): ReleaseVersion | null {
  const match = VERSION_TAG.exec(tag);
  if (match === null) {
    return null;
  }
  return { version: tag.slice(1), preRelease: match[1] === '0' || match[4] !== undefined };
}

/** Gives the part of the changelog written for a version, without its heading, or null when the changelog has none. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => SECTION_START.exec(line)?.[1] === version);
  if (start === -1) {
    return null;
  }
  const length = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const section = lines.slice(start + 1, length === -1 ? undefined : start + 1 + length);
  return section.join('\n').trim();
}

/** Writes the notes of a release from its part of the changelog, followed by what its files are and how to check them. */
export function releaseNotes(section: string, version: string): string {
  return `${section}\n\n${SIGNATURE_NOTE.replaceAll('{version}', version)}\n`;
}

/** Writes the fingerprints of the files of a release the way sha256sum does, one file a line in the order of their names. */
export function checksumsText(fingerprints: readonly FileFingerprint[]): string {
  return [...fingerprints]
    .sort((first, second) => first.name.localeCompare(second.name, 'en'))
    .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
    .join('');
}
