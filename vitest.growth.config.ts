import { defineConfig } from 'vitest/config';

const GROWTH_TEST_TIMEOUT_MS = 300_000;
const RETRIES_ON_NOISE = 2;

export default defineConfig({
  test: {
    include: ['tests/growth/**/*.growth.test.ts'],
    testTimeout: GROWTH_TEST_TIMEOUT_MS,
    hookTimeout: GROWTH_TEST_TIMEOUT_MS,
    retry: RETRIES_ON_NOISE,
    fileParallelism: false,
  },
});
