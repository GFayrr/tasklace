import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  bundledPackages,
  licenseFileOf,
  mitLicenseText,
  noticesText,
  shippedPackages,
  type PackageNotice,
  type ShippedPackage,
} from './third-party-notices.ts';

const ROOT = join(import.meta.dirname, '..');
const LICENSES_FOLDER = join(ROOT, 'out', 'licenses');
const NOTICES_FILE = join(LICENSES_FOLDER, 'THIRD-PARTY-NOTICES.txt');
const BUNDLED_LISTS = ['bundled-main.json', 'bundled-preload.json', 'bundled-renderer.json'];

/** Reads the names of the packages the builds of the main process, the bridge and the page hold, which the build writes, failing when a list is missing or is not a list of names. */
async function bundledNames(): Promise<string[]> {
  const names: string[] = [];
  for (const list of BUNDLED_LISTS) {
    const value: unknown = JSON.parse(await readFile(join(LICENSES_FOLDER, list), 'utf8'));
    if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) {
      throw new Error(`${list} is not a list of package names; build the application first.`);
    }
    names.push(...value);
  }
  return names;
}

/** Reads the license text of a shipped package, or writes the MIT license it declares without shipping, failing the build otherwise, since every package must ship with its license. */
async function noticeOf(shipped: ShippedPackage): Promise<string> {
  const folder = join(ROOT, shipped.folder);
  const licenseFile = licenseFileOf(await readdir(folder));
  if (licenseFile !== null) {
    return await readFile(join(folder, licenseFile), 'utf8');
  }
  const packageFile: unknown = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
  const author =
    typeof packageFile === 'object' && packageFile !== null && 'author' in packageFile
      ? packageFile.author
      : null;
  const written = mitLicenseText(shipped.license, author);
  if (written === null) {
    throw new Error(`${shipped.folder} has no license file to ship with it.`);
  }
  return written;
}

/** Writes the notices of every package shipped with the application, installed to run it or bundled into it, next to the built application. */
async function writeNotices(): Promise<void> {
  const lock: unknown = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
  const notices: PackageNotice[] = [];
  for (const shipped of [
    ...shippedPackages(lock),
    ...bundledPackages(lock, await bundledNames()),
  ]) {
    notices.push({ ...shipped, licenseText: await noticeOf(shipped) });
  }
  await mkdir(dirname(NOTICES_FILE), { recursive: true });
  await writeFile(NOTICES_FILE, noticesText(notices));
  console.log(`Wrote the notices of ${String(notices.length)} packages.`);
}

await writeNotices();
