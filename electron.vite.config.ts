import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: 'src/main/index.ts', 'file-worker': 'src/main/file-worker.ts' },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [svelte()],
  },
});
