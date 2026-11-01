export interface ShippedPackage {
  readonly folder: string;
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
}

export interface PackageNotice extends ShippedPackage {
  readonly licenseText: string;
}

const PACKAGE_FOLDER = 'node_modules/';
const MIT = 'MIT';
const AUTHOR_CONTACT = /\s*[<(].*$/;
const MIT_PERMISSION = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const LICENSE_FILE = /^(licen[cs]e|copying)(\..*)?$/i;
const SEPARATOR = '-'.repeat(72);
const NOTICES_HEADING =
  'Tasklace includes the following open source packages, each under the license given with it.';

/** Lists the packages a lock file installs for running the application, leaving out those only used to develop or build it. */
export function shippedPackages(lock: unknown): ShippedPackage[] {
  const packages = isRecord(lock) && isRecord(lock['packages']) ? lock['packages'] : null;
  if (packages === null) {
    throw new Error('The lock file lists no packages.');
  }
  return Object.entries(packages)
    .filter(([folder]) => folder.startsWith(PACKAGE_FOLDER))
    .flatMap(([folder, entry]) => (isShipped(entry) ? [packageOf(folder, entry)] : []));
}

/** Gives the lock file entries of the packages a bundle holds, which may be installed only to build the application, failing for a package the lock file does not install at the top of its folders. */
export function bundledPackages(lock: unknown, names: readonly string[]): ShippedPackage[] {
  const packages = isRecord(lock) && isRecord(lock['packages']) ? lock['packages'] : null;
  if (packages === null) {
    throw new Error('The lock file lists no packages.');
  }
  return names.map((name) => {
    const folder = `${PACKAGE_FOLDER}${name}`;
    const entry = packages[folder];
    if (!isRecord(entry)) {
      throw new Error(`The bundled package ${name} is not in the lock file.`);
    }
    return packageOf(folder, entry);
  });
}

/** Tells whether an entry of the lock file is installed for running the application. */
function isShipped(entry: unknown): entry is Record<string, unknown> {
  return isRecord(entry) && entry['dev'] !== true && entry['devOptional'] !== true;
}

/** Reads the name, version and declared license of a package from its entry in the lock file. */
function packageOf(folder: string, entry: Record<string, unknown>): ShippedPackage {
  const name = folder.slice(folder.lastIndexOf(PACKAGE_FOLDER) + PACKAGE_FOLDER.length);
  const version = entry['version'];
  const license = entry['license'];
  if (typeof version !== 'string') {
    throw new Error(`The lock file gives no version for ${name}.`);
  }
  return { folder, name, version, license: typeof license === 'string' ? license : null };
}

/** Picks the license file among the files of a package, the first in alphabetical order, or null when it has none. */
export function licenseFileOf(fileNames: readonly string[]): string | null {
  return fileNames.filter((fileName) => LICENSE_FILE.test(fileName)).sort()[0] ?? null;
}

/** Writes the MIT license of a package that declares it without shipping its text, naming the author its package file gives, or returns null when the package is not under the MIT license or names no author. */
export function mitLicenseText(license: string | null, author: unknown): string | null {
  const holder = authorName(author);
  if (license !== MIT || holder === null) {
    return null;
  }
  return `MIT License\n\nCopyright (c) ${holder}\n\n${MIT_PERMISSION}`;
}

/** Reads the name of an author given as text or as an object with a name, without its address. */
function authorName(author: unknown): string | null {
  const text = isRecord(author) ? author['name'] : author;
  const name = typeof text === 'string' ? text.replace(AUTHOR_CONTACT, '').trim() : '';
  return name === '' ? null : name;
}

/** Writes the notice of every package once, sorted by name and version, each with its license and the text of its license. */
export function noticesText(notices: readonly PackageNotice[]): string {
  const unique = new Map(notices.map((notice) => [`${notice.name}@${notice.version}`, notice]));
  const sections = [...unique.entries()]
    .sort(([first], [second]) => first.localeCompare(second, 'en'))
    .map(([key, notice]) =>
      [
        SEPARATOR,
        `${key} · ${notice.license ?? 'license given in its text below'}`,
        SEPARATOR,
        notice.licenseText.trim(),
      ].join('\n'),
    );
  return `${[NOTICES_HEADING, ...sections].join('\n\n')}\n`;
}

/** Tells whether a value is a plain object whose keys can be read. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
