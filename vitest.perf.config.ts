import { defineConfig } from 'vitest/config';

const BENCH_HEAP_MEBIBYTES = 8_192;

export default defineConfig({
  test: {
    execArgv: [`--max-old-space-size=${String(BENCH_HEAP_MEBIBYTES)}`],
    include: ['tests/perf/**/*.perf.test.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
