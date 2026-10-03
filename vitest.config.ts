import { svelte } from '@sveltejs/vite-plugin-svelte';
import { configDefaults, defineConfig } from 'vitest/config';

const COVERAGE_THRESHOLD_PERCENT = 90;
const NOT_UNIT_TESTS = [...configDefaults.exclude, 'tests/perf/**', 'tests/growth/**'];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: [
            'src/core/**/*.test.ts',
            'src/main/**/*.test.ts',
            'src/preload/**/*.test.ts',
            'tests/**/*.test.ts',
          ],
          exclude: NOT_UNIT_TESTS,
          environment: 'node',
        },
      },
      {
        plugins: [svelte({ compilerOptions: { hmr: false } })],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'interface',
          include: ['src/renderer/**/*.test.ts'],
          exclude: NOT_UNIT_TESTS,
          environment: 'happy-dom',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,svelte}'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/core/testing/**',
        'src/main/testing/**',
        'src/renderer/**/testing/**',
        'src/core/model/**',
        'src/main/index.ts',
        'src/main/file-worker.ts',
        'src/renderer/main.ts',
        'src/renderer/schedule/schedule-worker.ts',
      ],
      thresholds: {
        perFile: true,
        lines: COVERAGE_THRESHOLD_PERCENT,
        branches: COVERAGE_THRESHOLD_PERCENT,
        functions: COVERAGE_THRESHOLD_PERCENT,
        statements: COVERAGE_THRESHOLD_PERCENT,
      },
    },
  },
});
