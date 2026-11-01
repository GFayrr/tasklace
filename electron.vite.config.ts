import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'electron-vite';
import { bundledPackagesPlugin } from './scripts/bundled-packages';

const LICENSES_FOLDER = join(import.meta.dirname, 'out', 'licenses');

export default defineConfig({
  main: {
    plugins: [bundledPackagesPlugin(join(LICENSES_FOLDER, 'bundled-main.json'))],
    build: {
      rollupOptions: {
        input: { index: 'src/main/index.ts', 'file-worker': 'src/main/file-worker.ts' },
      },
    },
  },
  preload: {
    plugins: [bundledPackagesPlugin(join(LICENSES_FOLDER, 'bundled-preload.json'))],
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [svelte(), bundledPackagesPlugin(join(LICENSES_FOLDER, 'bundled-renderer.json'))],
  },
});
