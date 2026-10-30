import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pngSize, readIco } from '../../scripts/ico-file.ts';

const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const WINDOW_ICON_SIZE = 256;
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

interface PackageFile {
  readonly productName: unknown;
  readonly version: unknown;
}

/** Reads the package file of the application. */
function packageFile(): PackageFile {
  return JSON.parse(readFileSync('package.json', 'utf8')) as PackageFile;
}

describe('release files', () => {
  it.each(['build/icons/tasklace.ico', 'build/icons/tasklace-file.ico'])(
    'ships %s with every size Windows asks for, each a PNG of its size',
    (path) => {
      const images = readIco(new Uint8Array(readFileSync(path)));
      expect(images.map(({ size }) => size)).toEqual(ICON_SIZES);
    },
  );

  it('gives the window a PNG icon of 256 pixels', () => {
    expect(pngSize(new Uint8Array(readFileSync('resources/icon.png')))).toEqual({
      width: WINDOW_ICON_SIZE,
      height: WINDOW_ICON_SIZE,
    });
  });

  it('names the application Tasklace and numbers it with a semantic version', () => {
    const { productName, version } = packageFile();
    expect(productName).toBe('Tasklace');
    expect(typeof version === 'string' && SEMANTIC_VERSION.test(version)).toBe(true);
  });

  it('keeps a changelog with a part for the changes to come or for the current version', () => {
    const { version } = packageFile();
    const headings = readFileSync('CHANGELOG.md', 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('## '));
    expect(
      headings.some(
        (line) => line === '## [Unreleased]' || line.startsWith(`## [${String(version)}] - `),
      ),
    ).toBe(true);
  });
});
