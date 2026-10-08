import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { APP_ENTRY_URL, createAppFileServer, isAppAddress, resolveAppFile } from './app-files';

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

describe('createAppFileServer', () => {
  const HEADERS = { 'Content-Security-Policy': "default-src 'self'" };

  it('serves a file of the interface with its type and the security headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tasklace-interface-'));
    try {
      await writeFile(join(root, 'index.html'), '<p>Tasklace</p>');
      const response = await createAppFileServer(root, HEADERS)(new Request(APP_ENTRY_URL));
      expect([response.status, await response.text()]).toEqual([200, '<p>Tasklace</p>']);
      expect([...response.headers]).toEqual([
        ['content-security-policy', "default-src 'self'"],
        ['content-type', 'text/html; charset=utf-8'],
      ]);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('answers not found for an address outside the interface and for a missing file, logging nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tasklace-interface-'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await writeFile(join(root, 'index.html'), '<p>Tasklace</p>');
      const serve = createAppFileServer(root, HEADERS);
      const outside = await serve(new Request('app://elsewhere/index.html'));
      const missing = await serve(new Request('app://tasklace/missing.html'));
      expect([outside.status, missing.status]).toEqual([404, 404]);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      await rm(root, { recursive: true });
    }
  });

  it('answers not found for a file that cannot be read, logging why', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tasklace-interface-'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await mkdir(join(root, 'index.html'));
      const response = await createAppFileServer(root, HEADERS)(new Request(APP_ENTRY_URL));
      expect(response.status).toBe(404);
      expect(logged.mock.calls).toEqual([
        ['A file of the interface could not be read:', expect.objectContaining({ code: 'EISDIR' })],
      ]);
    } finally {
      logged.mockRestore();
      await rm(root, { recursive: true });
    }
  });
});
