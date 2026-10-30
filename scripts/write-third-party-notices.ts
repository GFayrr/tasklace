import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  licenseFileOf,
  mitLicenseText,
  noticesText,
  shippedPackages,
  type PackageNotice,
  type ShippedPackage,
} from './third-party-notices.ts';

const ROOT = join(import.meta.dirname, '..');
const NOTICES_FILE = join(ROOT, 'out', 'licenses', 'THIRD-PARTY-NOTICES.txt');

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

/** Writes the notices of every package shipped with the application next to the built application. */
async function writeNotices(): Promise<void> {
  const lock: unknown = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
  const notices: PackageNotice[] = [];
  for (const shipped of shippedPackages(lock)) {
    notices.push({ ...shipped, licenseText: await noticeOf(shipped) });
  }
  await mkdir(dirname(NOTICES_FILE), { recursive: true });
  await writeFile(NOTICES_FILE, noticesText(notices));
  console.log(`Wrote the notices of ${String(notices.length)} packages.`);
}

await writeNotices();
