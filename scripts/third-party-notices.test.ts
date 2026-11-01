import { describe, expect, it } from 'vitest';
import {
  bundledPackages,
  licenseFileOf,
  mitLicenseText,
  noticesText,
  shippedPackages,
  type PackageNotice,
} from './third-party-notices.ts';

describe('shippedPackages', () => {
  it('keeps the packages installed to run the application, nested ones included, and leaves out those of development', () => {
    const lock = {
      packages: {
        '': { name: 'tasklace' },
        'node_modules/ws': { version: '8.22.0', license: 'MIT' },
        'node_modules/@noble/hashes': { version: '2.4.0', license: 'MIT' },
        'node_modules/pdfkit/node_modules/png-js': { version: '2.0.0' },
        'node_modules/vitest': { version: '5.0.5', license: 'MIT', dev: true },
        'node_modules/fsevents': { version: '2.3.3', license: 'MIT', devOptional: true },
      },
    };
    expect(shippedPackages(lock)).toEqual([
      { folder: 'node_modules/ws', name: 'ws', version: '8.22.0', license: 'MIT' },
      {
        folder: 'node_modules/@noble/hashes',
        name: '@noble/hashes',
        version: '2.4.0',
        license: 'MIT',
      },
      {
        folder: 'node_modules/pdfkit/node_modules/png-js',
        name: 'png-js',
        version: '2.0.0',
        license: null,
      },
    ]);
  });

  it('refuses a lock file without packages, and a package without a version', () => {
    const noPackages = new Error('The lock file lists no packages.');
    expect(() => shippedPackages(null)).toThrow(noPackages);
    expect(() => shippedPackages({ packages: [] })).toThrow(noPackages);
    expect(() => shippedPackages({ packages: { 'node_modules/ws': { license: 'MIT' } } })).toThrow(
      new Error('The lock file gives no version for ws.'),
    );
  });

  it('skips an entry that is not an object', () => {
    expect(shippedPackages({ packages: { 'node_modules/ws': 'broken' } })).toEqual([]);
  });
});

describe('licenseFileOf', () => {
  it('picks the license file whatever its spelling, case or extension', () => {
    expect(licenseFileOf(['index.js', 'LICENSE', 'README.md'])).toBe('LICENSE');
    expect(licenseFileOf(['licence.txt', 'package.json'])).toBe('licence.txt');
    expect(licenseFileOf(['COPYING', 'LICENSE.md'])).toBe('COPYING');
    expect(licenseFileOf(['index.js', 'license-checker.js'])).toBeNull();
  });
});

describe('mitLicenseText', () => {
  it('writes the MIT license with the author named in the package file, without the address', () => {
    const text = mitLicenseText('MIT', 'Devon Govett <devongovett@gmail.com>');
    expect(text?.split('\n\n').slice(0, 2)).toEqual(['MIT License', 'Copyright (c) Devon Govett']);
    expect(text?.endsWith('OTHER DEALINGS IN THE SOFTWARE.')).toBe(true);
    expect(mitLicenseText('MIT', { name: 'Ada (https://example.org)' })?.split('\n\n')[1]).toBe(
      'Copyright (c) Ada',
    );
  });

  it('writes nothing for another license or a package that names no author', () => {
    expect(mitLicenseText('Apache-2.0', 'Ada')).toBeNull();
    expect(mitLicenseText(null, 'Ada')).toBeNull();
    expect(mitLicenseText('MIT', undefined)).toBeNull();
    expect(mitLicenseText('MIT', '  <ada@example.org>')).toBeNull();
    expect(mitLicenseText('MIT', { email: 'ada@example.org' })).toBeNull();
  });
});

/** Makes the notice of a package at version 1.0.0. */
function notice(name: string, license: string | null, licenseText: string): PackageNotice {
  return { folder: `node_modules/${name}`, name, version: '1.0.0', license, licenseText };
}

describe('noticesText', () => {
  it('writes each package once, sorted, with its license and text', () => {
    const rule = '-'.repeat(72);
    expect(
      noticesText([
        notice('ws', 'MIT', 'ws text\n'),
        notice('png-js', null, 'png text'),
        notice('ws', 'MIT', 'ws text\n'),
      ]),
    ).toBe(
      [
        'Tasklace includes the following open source packages, each under the license given with it.',
        `${rule}\npng-js@1.0.0 · license given in its text below\n${rule}\npng text`,
        `${rule}\nws@1.0.0 · MIT\n${rule}\nws text`,
      ].join('\n\n') + '\n',
    );
  });
});

describe('bundledPackages', () => {
  it('gives the entries of the packages a bundle holds, even those only installed to build the application', () => {
    const lock = {
      packages: {
        'node_modules/svelte': { version: '5.57.1', license: 'MIT', dev: true },
        'node_modules/@noble/hashes': { version: '2.4.0', license: 'MIT' },
      },
    };
    expect(bundledPackages(lock, ['svelte', '@noble/hashes'])).toEqual([
      { folder: 'node_modules/svelte', name: 'svelte', version: '5.57.1', license: 'MIT' },
      {
        folder: 'node_modules/@noble/hashes',
        name: '@noble/hashes',
        version: '2.4.0',
        license: 'MIT',
      },
    ]);
  });

  it('fails for a package the lock file does not have, and for a lock file without packages', () => {
    expect(() => bundledPackages({ packages: {} }, ['clsx'])).toThrow(
      'The bundled package clsx is not in the lock file.',
    );
    expect(() => bundledPackages({}, [])).toThrow('The lock file lists no packages.');
  });
});
