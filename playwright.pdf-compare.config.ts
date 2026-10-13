import { defineConfig } from '@playwright/test';

const COMPARE_TIMEOUT_MS = 1_800_000;

export default defineConfig({
  testDir: 'tests/pdf-compare',
  timeout: COMPARE_TIMEOUT_MS,
  workers: 1,
  reporter: 'list',
});
