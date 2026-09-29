import { isAbsolute, join, relative, resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { APP_ENTRY_URL, isAppAddress, resolveAppFile } from './app-files';

const ROOT = resolve('/tasklace/renderer');
const DEVELOPMENT_ORIGIN = 'http://localhost:5173';

describe('resolveAppFile', () => {
  it('finds the entry page and the assets of the interface with their type', () => {
    expect(resolveAppFile(ROOT, APP_ENTRY_URL)).toEqual({
      path: join(ROOT, 'index.html'),
      contentType: 'text/html; charset=utf-8',
    });
    expect(resolveAppFile(ROOT, 'app://tasklace/assets/index-1.js?v=2#x')).toEqual({
      path: join(ROOT, 'assets', 'index-1.js'),
      contentType: 'text/javascript; charset=utf-8',
    });
  });

  it('keeps addresses climbing above the root inside the folder, as the address parser does', () => {
    for (const address of ['app://tasklace/../secret.html', 'app://tasklace/%2e%2e/secret.html']) {
      expect(resolveAppFile(ROOT, address)?.path).toBe(join(ROOT, 'secret.html'));
    }
  });

  it('never gives a file outside the folder, whatever the address', () => {
    const segment = fc.constantFrom(
      '..',
      '.',
      '%2e%2e',
      '%2E%2E',
      '%2f',
      '%5c',
      '\\',
      'assets',
      'a.js',
      'x.html',
      '%00',
      '%',
    );
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 8 }), (segments) => {
        const file = resolveAppFile(ROOT, `app://tasklace/${segments.join('/')}`);
        const inside = file === null ? '' : relative(ROOT, file.path);
        expect(file === null || (!inside.startsWith('..') && !isAbsolute(inside))).toBe(true);
      }),
    );
  });

  it.each([
    'app://tasklace/assets/%2e%2e%2f%2e%2e%2fsecret.html',
    'app://tasklace/%2E%2E%5Csecret.html',
    'app://tasklace/',
    'app://tasklace/notes.txt',
    'app://tasklace/assets/%E0%A4%A.js',
    'app://other/index.html',
    'https://tasklace/index.html',
    'file:///tasklace/renderer/index.html',
    'not a url',
  ])('refuses %s', (address) => {
    expect(resolveAppFile(ROOT, address)).toBeNull();
  });
});

describe('isAppAddress', () => {
  it('recognizes the pages of the application and of the development server only', () => {
    expect(isAppAddress(APP_ENTRY_URL, null)).toBe(true);
    expect(isAppAddress('http://localhost:5173/index.html', DEVELOPMENT_ORIGIN)).toBe(true);
    expect(isAppAddress('http://localhost:5173/index.html', null)).toBe(false);
    expect(isAppAddress('http://localhost:5174/index.html', DEVELOPMENT_ORIGIN)).toBe(false);
    expect(isAppAddress('app://other/index.html', DEVELOPMENT_ORIGIN)).toBe(false);
    expect(isAppAddress('', null)).toBe(false);
  });
});
