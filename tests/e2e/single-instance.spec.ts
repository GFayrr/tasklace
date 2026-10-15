import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { closeDiscarding, launchApplication } from './application';

const SECOND_LAUNCH_LIMIT_MS = 20_000;

let userData: string;
let application: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-single-'));
  application = await launchApplication(userData);
  page = await application.firstWindow();
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
});

test.afterEach(async () => {
  await closeDiscarding(application, page);
  await rm(userData, { recursive: true, force: true });
});

/** Returns the path of the Electron executable, which the electron package gives to Node. */
function electronExecutable(): string {
  const path: unknown = createRequire(import.meta.url)('electron');
  if (typeof path !== 'string') {
    throw new Error('The electron package gave no executable path.');
  }
  return path;
}

interface Ending {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly errors: string;
}

/** Returns the arguments of a second launch on the same user data, with the sandbox turned off on Linux as Playwright does for the first one, since the machines of the CI cannot start the sandbox of Chromium. */
function secondLaunchArguments(): string[] {
  const shared = ['.', `--user-data-dir=${userData}`];
  return process.platform === 'linux' ? ['--no-sandbox', ...shared] : shared;
}

/** Launches the application a second time on the same user data, returning how that process ended on its own and what it wrote as errors. */
function launchAgain(): Promise<Ending> {
  return new Promise((resolve, reject) => {
    const second = spawn(electronExecutable(), secondLaunchArguments(), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const errors: string[] = [];
    second.stderr.on('data', (chunk: Buffer) => {
      errors.push(chunk.toString());
    });
    const timer = setTimeout(() => {
      second.kill();
      reject(
        new Error(`The second launch did not end within ${String(SECOND_LAUNCH_LIMIT_MS)} ms.`),
      );
    }, SECOND_LAUNCH_LIMIT_MS);
    second.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    second.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, errors: errors.join('') });
    });
  });
}

test('keeps a single instance: a second launch ends at once and brings the first window forward', async () => {
  await application.evaluate(({ app }) => {
    app.once('second-instance', () => {
      Reflect.set(globalThis, 'secondInstanceSeen', true);
    });
  });
  const ending = await launchAgain();
  expect([ending.code, ending.signal], ending.errors).toEqual([0, null]);
  await expect
    .poll(() => application.evaluate(() => Reflect.get(globalThis, 'secondInstanceSeen') === true))
    .toBe(true);
  expect(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  ).toBe(1);
});
