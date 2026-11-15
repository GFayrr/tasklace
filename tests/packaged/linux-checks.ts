import { existsSync } from 'node:fs';
import { test } from '@playwright/test';

const LINUX_INTEGRATION = process.env['CI'] === 'true' && process.platform === 'linux';
const PACKAGE_KINDS = ['deb', 'rpm'] as const;
const IN_CONTAINER = '1';
const CONTAINER_MARKS = ['/.dockerenv', '/run/.containerenv'];

export type PackageKind = (typeof PACKAGE_KINDS)[number];

/** Reads which Linux package is installed, refusing any other value so that a mistyped value never turns the tests off. */
function readInstalledPackage(value: string | undefined): PackageKind | null {
  if (value === undefined) {
    return null;
  }
  const kind = PACKAGE_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) {
    throw new Error(`TASKLACE_INSTALLED_PACKAGE must be deb or rpm, not ${value}.`);
  }
  return kind;
}

/** Reads whether the RPM package is tested in a container, refusing the variable anywhere else so that it never turns the sandbox off on a real computer. */
function readInContainer(value: string | undefined, kind: PackageKind | null): boolean {
  if (value === undefined) {
    return false;
  }
  if (value !== IN_CONTAINER) {
    throw new Error(`TASKLACE_IN_CONTAINER must be ${IN_CONTAINER} or unset, not ${value}.`);
  }
  if (kind !== 'rpm') {
    throw new Error('TASKLACE_IN_CONTAINER is only for the RPM package tested in a container.');
  }
  if (!CONTAINER_MARKS.some((mark) => existsSync(mark))) {
    throw new Error('TASKLACE_IN_CONTAINER is set on a computer that is not a container.');
  }
  return true;
}

const installedPackage = readInstalledPackage(process.env['TASKLACE_INSTALLED_PACKAGE']);

export const isPackageInstalled = installedPackage !== null;

export const isInContainer = readInContainer(
  process.env['TASKLACE_IN_CONTAINER'],
  installedPackage,
);

export const launchesWithSandbox = isPackageInstalled && !isInContainer;

/** Fails on the Linux machines of continuous integration when the package is said not to be installed, so that a lost TASKLACE_INSTALLED_PACKAGE never turns its tests off without a word. */
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

/** Gives which package a test that needs it checks, failing if the test runs without one rather than guessing. */
export function requireInstalledPackage(): PackageKind {
  if (installedPackage === null) {
    throw new Error('A test of the installed package ran without the package.');
  }
  return installedPackage;
}
