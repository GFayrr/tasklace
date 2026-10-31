import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundledPackagesPlugin, packageNameOf, packagesOfBundle } from './bundled-packages.ts';

let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-bundled-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('packageNameOf', () => {
  it('names the package a module comes from, scoped or not, nested or not, on any system', () => {
    expect(
      [
        '/repo/node_modules/svelte/src/internal/client/index.js',
        'C:\\repo\\node_modules\\@noble\\hashes\\esm\\sha2.js',
        '/repo/node_modules/pdfkit/node_modules/png-js/png.js',
        '\0/repo/node_modules/clsx/dist/clsx.mjs?commonjs-proxy',
        '/repo/src/renderer/main.ts',
        '\0vite/preload-helper.js',
        '/repo/node_modules/@scope',
        '/repo/node_modules/',
      ].map(packageNameOf),
    ).toEqual(['svelte', '@noble/hashes', 'png-js', 'clsx', null, null, null, null]);
  });
});

describe('packagesOfBundle', () => {
  it('lists once, in order, the packages the chunks of a bundle hold, leaving out assets', () => {
    expect(
      packagesOfBundle({
        'index.js': {
          type: 'chunk',
          moduleIds: [
            '/repo/node_modules/yjs/dist/yjs.mjs',
            '/repo/src/renderer/main.ts',
            '/repo/node_modules/svelte/src/index.js',
          ],
        },
        'en.js': { type: 'chunk', moduleIds: ['/repo/node_modules/svelte/src/store.js'] },
        'style.css': { type: 'asset' },
        'empty.js': { type: 'chunk' },
      }),
    ).toEqual(['svelte', 'yjs']);
  });
});

describe('bundledPackagesPlugin', () => {
  it('writes the list of the packages of a bundle once it is written, creating its folder', async () => {
    const listFile = join(folder, 'licenses', 'bundled-renderer.json');
    const plugin = bundledPackagesPlugin(listFile);
    expect(plugin.name).toBe('tasklace-bundled-packages');
    plugin.generateBundle(null, {
      'index.js': { type: 'chunk', moduleIds: ['/repo/node_modules/esm-env/index.js'] },
    });
    await plugin.closeBundle();
    expect(await readFile(listFile, 'utf8')).toBe('[\n  "esm-env"\n]\n');
  });
});
