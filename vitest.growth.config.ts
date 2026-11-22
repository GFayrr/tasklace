import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const GROWTH_TEST_TIMEOUT_MS = 300_000;
const RETRIES_ON_NOISE = 2;
const INTERFACE_GROWTH_TESTS = 'tests/growth/**/*.interface.growth.test.ts';

export default defineConfig({
  test: {
    testTimeout: GROWTH_TEST_TIMEOUT_MS,
    hookTimeout: GROWTH_TEST_TIMEOUT_MS,
    retry: RETRIES_ON_NOISE,
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['tests/growth/**/*.growth.test.ts'],
          exclude: [INTERFACE_GROWTH_TESTS],
          environment: 'node',
        },
      },
      {
        extends: true,
        plugins: [svelte({ compilerOptions: { hmr: false } })],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'interface',
          include: [INTERFACE_GROWTH_TESTS],
          environment: 'happy-dom',
        },
      },
    ],
  },
});
