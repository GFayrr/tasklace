import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { answerDialogs, closeDiscarding } from './dialogs';

let folder: string;
let userData: string;
let application: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-e2e-closing-'));
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-data-'));
  application = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] });
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
  const closeWindow = () =>
    application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
  await closeWindow();
  const prompt = page.getByRole('dialog', { name: 'Save this project?' });
  await prompt.getByRole('button', { name: 'Cancel' }).click();
  await expect(prompt).toBeHidden();
  expect(application.windows()).toHaveLength(1);
  const closed = new Promise((resolve) => page.once('close', resolve));
  await closeWindow();
  await prompt.getByRole('button', { name: "Don't save" }).click();
  await closed;
});
