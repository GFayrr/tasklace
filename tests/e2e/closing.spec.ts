import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import english from '../../src/renderer/locales/en.json' with { type: 'json' };
import { closeDiscarding, launchApplication } from './application';
import { answerDialogs, answerQuestions, askedDetails, suggestedPath } from './dialogs';

let folder: string;
let userData: string;
const STARTING_CLOSE_ATTEMPTS = 3;
const EXIT_LIMIT_MS = 15_000;
const TIMED_OUT = 'timed out';

let application: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-e2e-closing-'));
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-data-'));
  application = await launchApplication(userData);
  page = await application.firstWindow();
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
  await page.getByRole('button', { name: /New project/ }).click();
});

test.afterEach(async () => {
  await closeDiscarding(application, page);
  await rm(folder, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

/** Renames the open project, a change that only its local copy keeps until it is saved to a file. */
async function rename(name: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Project name' });
  await field.fill(name);
  await field.press('Enter');
  await expect(field).toHaveValue(name);
}

test('asks before replacing a changed project that has no file, and cancelling keeps it', async () => {
  await rename('Thesis');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: 'Save this project?' });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Cancel' }).click();
  await expect(prompt).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Thesis');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await prompt.getByRole('button', { name: "Don't save" }).click();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Untitled project');
});

test('saves the project where the user chooses before replacing it', async () => {
  const path = join(folder, 'Thesis.tasklace');
  await answerDialogs(application, { save: path });
  await rename('Thesis');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Save this project?' })
    .getByRole('button', { name: 'Save…' })
    .click();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Untitled project');
  expect((await readFile(path)).subarray(0, 4).toString()).toBe('TSKL');
});

test('does not ask for an untouched project', async () => {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Save this project?' })).toBeHidden();
});

test('asks before the window closes, keeping it open on cancel', async () => {
  await rename('Thesis');
  await closeWindow();
  const prompt = page.getByRole('dialog', { name: 'Save this project?' });
  await prompt.getByRole('button', { name: 'Cancel' }).click();
  await expect(prompt).toBeHidden();
  expect(application.windows()).toHaveLength(1);
  const closed = new Promise((resolve) => page.once('close', resolve));
  await closeWindow();
  await Promise.all([closed, clickClosing(prompt.getByRole('button', { name: "Don't save" }))]);
});

/** Clicks a button that closes the window, ignoring the error raised because the page closes during the click. */
async function clickClosing(button: Locator): Promise<void> {
  await button.click().catch((error: unknown) => {
    if (!(error instanceof Error && /closed/i.test(error.message))) {
      throw error;
    }
  });
}

/** Asks the window of the application to close, as its close button does. */
async function closeWindow(): Promise<void> {
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
}

test('keeps the window open when the last save fails, until the user saves elsewhere or closes without saving', async () => {
  const subfolder = join(folder, 'gone');
  await mkdir(subfolder);
  await answerDialogs(application, { save: join(subfolder, 'Thesis.tasklace') });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  await rm(subfolder, { recursive: true, force: true });
  await rename('Thesis');
  await closeWindow();
  const failed = page.getByRole('dialog', { name: 'The project could not be saved' });
  await expect(failed).toBeVisible();
  await expect(failed).toContainText('Check that the folder still exists');
  await failed.getByRole('button', { name: 'Cancel' }).click();
  await expect(failed).toBeHidden();
  expect(application.windows()).toHaveLength(1);
  const closed = new Promise((resolve) => page.once('close', resolve));
  await closeWindow();
  await Promise.all([
    closed,
    clickClosing(failed.getByRole('button', { name: 'Close without saving' })),
  ]);
});

/** Crashes the page of the window without waiting for what follows, since the main process may quit at once. */
async function crashPage(): Promise<void> {
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
  });
}

/** Waits for the process of the application to exit, giving its exit code, or a timeout message after a fixed delay. */
async function exitCode(exited: Promise<unknown>): Promise<unknown> {
  return Promise.race([exited, delay(EXIT_LIMIT_MS, TIMED_OUT)]);
}

test('offers to close a window whose page crashed before any close request, and closes it', async () => {
  await application.context().tracing.stop();
  await answerQuestions(application, { [english.pageProblems.reload]: english.pageProblems.close });
  const process = application.process();
  const exited = new Promise((resolve) => process.once('exit', resolve));
  await crashPage();
  expect(await exitCode(exited)).toBe(0);
});

test('offers to reload a window whose page crashed, which starts again with nothing open, checked through the main process since the crashed page cannot be driven any more', async () => {
  await rename('Thesis');
  await application.context().tracing.stop();
  await answerQuestions(application, {
    [english.pageProblems.reload]: english.pageProblems.reload,
  });
  await crashPage();
  await expect.poll(() => askedDetails(application)).toEqual([english.pageProblems.crashedBody]);
  const welcomed = (): Promise<unknown> =>
    application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(
        "document.getElementById('app')?.dataset.started === 'true' && document.querySelector('.welcome') !== null",
      ),
    );
  await expect.poll(welcomed).toBe(true);
  expect(application.windows()).toHaveLength(1);
});

test('never shows a second question while one is open, shortcuts waiting until it is answered', async () => {
  await answerDialogs(application, { save: join(folder, 'Thesis.tasklace') });
  await rename('Thesis');
  await closeWindow();
  const prompt = page.getByRole('dialog', { name: 'Save this project?' });
  await expect(prompt).toBeVisible();
  await page.keyboard.press('Control+s');
  await page.keyboard.press('Control+n');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(await suggestedPath(application)).toBeNull();
  const closed = new Promise((resolve) => page.once('close', resolve));
  await Promise.all([closed, clickClosing(prompt.getByRole('button', { name: "Don't save" }))]);
});

test('shows unexpected errors of the interface to the user and writes them to the log', async () => {
  await page.evaluate(() => {
    void Promise.reject(new Error('Rejected on purpose'));
  });
  const alert = page.getByRole('alert').filter({ hasText: english.notices.unexpectedError });
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: english.notices.dismiss }).click();
  await expect(alert).toBeHidden();
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('Thrown on purpose');
    }, 0);
  });
  await expect(alert).toBeVisible();
  await expect
    .poll(async () => readFile(join(userData, 'logs', 'tasklace.log'), 'utf8').catch(() => ''))
    .toMatch(/ERROR Page: .*Rejected on purpose[\s\S]*ERROR Page: .*Thrown on purpose/);
});

test('closes a window at once while its interface is still starting', async () => {
  for (let attempt = 0; attempt < STARTING_CLOSE_ATTEMPTS; attempt += 1) {
    const ownData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-starting-'));
    const starting = await launchApplication(ownData);
    const window = await starting.firstWindow();
    await closeDiscarding(starting, window);
    await rm(ownData, { recursive: true, force: true });
  }
});
