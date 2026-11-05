import { test } from '@playwright/test';

const LINUX_INTEGRATION = process.env['CI'] === 'true' && process.platform === 'linux';

export const isPackageInstalled = process.env['TASKLACE_INSTALLED_PACKAGE'] === '1';

/** Fails on the Linux machines of continuous integration when the package is said not to be installed, so that a lost variable never turns its tests off or the sandbox off without a word. */
export function refuseMissingPackage(): void {
  if (LINUX_INTEGRATION && !isPackageInstalled) {
    throw new Error('Continuous integration requires the tests of the installed package to run.');
  }
}

/** Skips a test that needs the installed package on a computer without it, which continuous integration refuses. */
export function skipUnlessInstalled(): void {
  refuseMissingPackage();
  test.skip(!isPackageInstalled, 'Only a computer with the package installed runs this test.');
}
