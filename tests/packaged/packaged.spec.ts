import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';

const EXECUTABLE = process.env['TASKLACE_PACKAGED_APP'] ?? '';
const LINUX_ARGUMENTS = process.platform === 'linux' ? ['--no-sandbox'] : [];
const CONNECT_ATTEMPTS = 60;
const CONNECT_STEP_MS = 500;
const RUN_AS_NODE_WAIT_MS = 10_000;
const REMOVAL_RETRIES = 10;
const REMOVAL_RETRY_STEP_MS = 200;
const NODE_ANSWER = 'ran as node';
const SAVE_WAIT_MS = 15_000;
const COPY_EXTENSION = '.tasklace';

interface Running {
  readonly child: ChildProcess;
  readonly browser: Browser;
  readonly page: Page;
}

let userData = '';
let running: Running | null = null;

test.beforeAll(() => {
  if (EXECUTABLE === '') {
    throw new Error('TASKLACE_PACKAGED_APP must give the path of the packaged executable.');
  }
});

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'tasklace-packaged-'));
  await writeFile(
    join(userData, 'update-check.json'),
    JSON.stringify({ version: 1, settings: { checkForNewVersions: false, lastCheckedOn: null } }),
  );
});

test.afterEach(async () => {
  if (running !== null) {
    await running.browser.close().catch(() => undefined);
    await stopProcessTree(running.child);
    running = null;
  }
  await rm(userData, {
    recursive: true,
    force: true,
    maxRetries: REMOVAL_RETRIES,
    retryDelay: REMOVAL_RETRY_STEP_MS,
  });
});

/** Finds a free port on this computer for the debugging connection. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === 'string') {
    throw new Error('No port could be found for the debugging connection.');
  }
  return address.port;
}

/** Starts the packaged executable with its own user data folder and connects to its window through the debugging port of Chromium, since its fuses refuse the Node inspector that Playwright uses for Electron. */
async function start(): Promise<Running> {
  const port = await freePort();
  const child = spawn(
    EXECUTABLE,
    [...LINUX_ARGUMENTS, `--user-data-dir=${userData}`, `--remote-debugging-port=${String(port)}`],
    { stdio: 'ignore' },
  );
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
    const browser = await chromium
      .connectOverCDP(`http://127.0.0.1:${String(port)}`)
      .catch(() => null);
    const page = browser?.contexts()[0]?.pages()[0];
    if (browser !== null && page !== undefined) {
      running = { child, browser, page };
      return running;
    }
    await browser?.close();
    await delay(CONNECT_STEP_MS);
  }
  await stopProcessTree(child);
  throw new Error('The packaged application did not open its window.');
}

/** Counts the local copies of projects the application wrote, none while its folder does not exist yet. */
async function savedCopies(): Promise<number> {
  const names = await readdir(join(userData, 'local-copies')).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  return names.filter((name) => name.endsWith(COPY_EXTENSION)).length;
}

/** Stops a process with every process it started, which Windows leaves running when only the first one is killed. */
async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
  await exited;
}

test('starts as Tasklace and saves a new project through its file worker, loaded from the archive', async () => {
  const { page } = await start();
  await expect(page).toHaveTitle('Tasklace');
  await page.getByRole('button', { name: /New project/ }).click();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Untitled project');
  await page
    .getByRole('group', { name: 'Task' })
    .getByRole('button', { name: 'Add a task' })
    .click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => await savedCopies(), { timeout: SAVE_WAIT_MS }).toBe(1);
});

test('draws the preview of a PDF with the printed fonts served from the archive', async () => {
  const { page } = await start();
  await page.getByRole('button', { name: /New project/ }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('menuitem', { name: 'PDF…' }).click();
  await expect(page.getByRole('dialog').getByText('Preview · page 1 of 1')).toBeVisible();
});

test('does not run as Node when asked to, its fuse being off', async () => {
  const child = spawn(
    EXECUTABLE,
    [
      ...LINUX_ARGUMENTS,
      `--user-data-dir=${userData}`,
      '-e',
      `process.stdout.write('${NODE_ANSWER}')`,
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  await delay(RUN_AS_NODE_WAIT_MS);
  const stillRunning = child.exitCode === null;
  await stopProcessTree(child);
  expect({ ranAsNode: output.includes(NODE_ANSWER), stillRunning }).toEqual({
    ranAsNode: false,
    stillRunning: true,
  });
});

test('shows its version in its settings, with the check for new versions turned off before launch, so that no test asks GitHub', async () => {
  const { page } = await start();
  const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
  await page.getByRole('button', { name: 'Tasklace settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Tasklace settings' });
  await expect(settings.locator('.part .row span').first()).toHaveText(`Tasklace ${version}`);
  await expect(settings.getByRole('switch', { name: 'Check for new versions' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  expect(JSON.parse(await readFile(join(userData, 'update-check.json'), 'utf8'))).toEqual({
    version: 1,
    settings: { checkForNewVersions: false, lastCheckedOn: null },
  });
});
