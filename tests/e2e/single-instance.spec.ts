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

/** Launches the application a second time on the same user data, returning the exit code of that process once it ends on its own. */
function launchAgain(): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const second = spawn(electronExecutable(), ['.', `--user-data-dir=${userData}`], {
      stdio: 'ignore',
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
    second.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test('keeps a single instance: a second launch ends at once and brings the first window forward', async () => {
  await application.evaluate(({ app }) => {
    app.once('second-instance', () => {
      Reflect.set(globalThis, 'secondInstanceSeen', true);
    });
  });
  expect(await launchAgain()).toBe(0);
  await expect
    .poll(() => application.evaluate(() => Reflect.get(globalThis, 'secondInstanceSeen') === true))
    .toBe(true);
  expect(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  ).toBe(1);
});
