import { test } from '@playwright/test';

const REQUIRED = process.env['TASKLACE_REQUIRE_WINDOWS_TESTS'] === '1';

/** Skips a test of Windows that cannot run here, unless continuous integration requires it, in which case it fails with the reason, so that a check never passes by being skipped. */
export function skipUnlessRequired(cannotRun: boolean, reason: string): void {
  if (cannotRun && REQUIRED) {
    throw new Error(`${reason} Continuous integration requires this test to run.`);
  }
  test.skip(cannotRun, reason);
}
