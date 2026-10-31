const NUMBER = String.raw`0|[1-9]\d{0,8}`;
const IDENTIFIER = String.raw`(?:${NUMBER}|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const VERSION_TAG = new RegExp(
  String.raw`^v(${NUMBER})\.(${NUMBER})\.(${NUMBER})(-${IDENTIFIER}(?:\.${IDENTIFIER})*)?$`,
);
const MAX_TAG_LENGTH = 65;
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

/** Reads the version a release tag names exactly as Tasklace reads the versions of its releases, a pre-release being any version before 1.0.0 or with a pre-release part, or returns null for a tag that is not a version. */
export function releaseVersionOf(tag: string): ReleaseVersion | null {
  const match = tag.length > MAX_TAG_LENGTH ? null : VERSION_TAG.exec(tag);
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

export interface ReleaseFiles {
  readonly version: string;
  readonly preRelease: boolean;
  readonly notes: string;
  readonly files: readonly string[];
}

/** Checks what a release needs before it is prepared: a tag naming the version of the application, its part of the changelog, and exactly its portable executable and installer among the built files, the only files it publishes with their fingerprints. */
export function checkRelease(
  tag: string,
  packageVersion: unknown,
  changelog: string,
  builtFiles: readonly string[],
): ReleaseFiles {
  const release = releaseVersionOf(tag);
  if (release === null) {
    throw new Error(`The tag ${tag} does not name a version such as v1.2.3.`);
  }
  const { version, preRelease } = release;
  if (packageVersion !== version) {
    throw new Error(
      `The tag ${tag} does not match the version ${String(packageVersion)} of package.json.`,
    );
  }
  const section = changelogSection(changelog, version);
  if (section === null || section === '') {
    throw new Error(`CHANGELOG.md has no part for the version ${version}.`);
  }
  const files = [`Tasklace-${version}-portable.exe`, `Tasklace-${version}-setup.exe`];
  const missing = files.filter((file) => !builtFiles.includes(file));
  if (missing.length > 0) {
    throw new Error(`The release needs ${missing.join(' and ')}, which the build did not make.`);
  }
  return { version, preRelease, notes: releaseNotes(section, version), files };
}
