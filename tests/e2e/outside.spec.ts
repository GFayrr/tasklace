import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { drawRelayAccess } from '../../src/core/collaboration/relay/relay-keys';
import { encodeRelayLink } from '../../src/core/collaboration/relay/relay-link';
import { encodeTasklaceFile } from '../../src/core/file/tasklace-file';
import { createSharedDocument, requireDocumentId } from '../../src/core/shared/shared-document';
import { seededRandom } from '../../src/core/testing/test-crypto';
import { project, workTask } from '../../src/core/testing/project-builder';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import { closeDiscarding, launchApplication } from './application';

const SECOND_LAUNCH_LIMIT_MS = 20_000;
const LINK = encodeRelayLink({
  address: { host: 'relay.school.example', port: null, path: '/' },
  access: drawRelayAccess(seededRandom(11)),
});

let folder: string;
let userData: string;
let application: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-e2e-outside-'));
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-outside-data-'));
});

test.afterEach(async () => {
  await closeDiscarding(application, page);
  await rm(folder, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

/** Launches the application with what Windows passes after the separator, and waits until its interface runs. */
async function launch(lastArguments: readonly string[] = []): Promise<void> {
  application = await launchApplication(userData, {}, lastArguments);
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
}

/** Writes a small project named after its file. */
async function writeProject(name: string): Promise<string> {
  const path = join(folder, `${name}.tasklace`);
  const named = { ...project([workTask('a')]), name };
  const document = createSharedDocument(named, requireDocumentId(crypto.randomUUID()));
  await writeFile(path, encodeTasklaceFile(document, zlibCompressor));
  return path;
}

/** Returns the path of the Electron executable, which the electron package gives to Node. */
function electronExecutable(): string {
  const path: unknown = createRequire(import.meta.url)('electron');
  if (typeof path !== 'string') {
    throw new Error('The electron package gave no executable path.');
  }
  return path;
}

/** Launches the application a second time on the same user data with a file or a link, as Windows does when one is double-clicked, and waits until that launch ends. */
function launchAgainWith(value: string): Promise<void> {
  const sandbox = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const second = spawn(
    electronExecutable(),
    [...sandbox, '.', `--user-data-dir=${userData}`, '--', value],
    { stdio: 'ignore' },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      second.kill();
      reject(new Error('The second launch did not end in time.'));
    }, SECOND_LAUNCH_LIMIT_MS);
    second.once('error', reject);
    second.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Returns the name of the open project. */
function projectName() {
  return page.getByRole('textbox', { name: 'Project name' });
}

test('opens the project file Tasklace was started with, as a double-click on it does', async () => {
  await launch(['--', await writeProject('Alpha')]);
  await expect(projectName()).toHaveValue('Alpha');
  await expect(page.locator('dialog.welcome-window')).not.toBeVisible();
});

test('fills the join window with a link clicked while Tasklace runs, joining nothing, then opens a file double-clicked', async () => {
  await launch();
  await launchAgainWith(LINK);
  const join = page.getByRole('dialog', { name: 'Join a shared plan' });
  await expect(join.getByRole('note')).toHaveText(
    'You opened a link from outside Tasklace. Join only if you expected it.',
  );
  await expect(join.getByRole('textbox', { name: 'Link you received' })).toHaveValue(LINK);
  await expect(join.getByText('relay.school.example', { exact: false })).toBeVisible();
  await join.getByRole('button', { name: 'Cancel' }).click();
  await expect(join).not.toBeVisible();
  await launchAgainWith(await writeProject('Beta'));
  await expect(projectName()).toHaveValue('Beta');
});

test('ignores anything else Tasklace is started with, then still takes what comes after it', async () => {
  const other = join(folder, 'Notes.txt');
  await writeFile(other, 'notes');
  await launch(['--', other]);
  await launchAgainWith('--gpu-launcher=notepad');
  await launchAgainWith(LINK);
  const joinWindow = page.getByRole('dialog', { name: 'Join a shared plan' });
  await expect(joinWindow.getByRole('textbox', { name: 'Link you received' })).toHaveValue(LINK);
  await expect(page.locator('.notices')).not.toContainText('Tasklace could not');
});

test('tells that a link it cannot read was opened, without its text', async () => {
  await launch();
  await launchAgainWith('tasklace://relay.school.example/#e1.cut');
  await expect(
    page.getByText(/The link you opened is not the link of a shared plan/),
  ).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Join a shared plan' })).not.toBeVisible();
});
