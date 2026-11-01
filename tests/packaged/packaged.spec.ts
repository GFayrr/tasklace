import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { skipUnlessRequired } from './windows-checks';
import { encodeTasklaceFile } from '../../src/core/file/tasklace-file';
import { createSharedDocument, requireDocumentId } from '../../src/core/shared/shared-document';
import { project, workTask } from '../../src/core/testing/project-builder';
import { zlibCompressor } from '../../src/main/zlib-compressor';

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
const CLASSES = 'HKCU\\Software\\Classes';
const COMMAND_KEY = `${CLASSES}\\Tasklace.Project\\shell\\open\\command`;
const TASKLACE_KEYS = [
  `${CLASSES}\\Tasklace.Project`,
  `${CLASSES}\\tasklace`,
  `${CLASSES}\\.tasklace`,
];
const DEFAULT_USER_DATA = join(process.env['APPDATA'] ?? '', 'Tasklace');

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
  await writeFile(
    join(userData, 'setup.json'),
    JSON.stringify({ version: 1, settings: { welcomed: true, registeredExecutable: null } }),
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

/** Starts the packaged executable with its own user data folder, or the folder Windows gives it, and connects to its window through the debugging port of Chromium, since its fuses refuse the Node inspector that Playwright uses for Electron. */
async function start(
  options: { readonly ownFolder?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<Running> {
  const port = await freePort();
  const folder = options.ownFolder === false ? [] : [`--user-data-dir=${userData}`];
  const child = spawn(
    EXECUTABLE,
    [...LINUX_ARGUMENTS, ...folder, `--remote-debugging-port=${String(port)}`],
    { stdio: 'ignore', env: { ...process.env, ...options.env } },
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

/** Runs the registry tool of Windows and gives its exit code and output. */
function registry(
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly output: string }> {
  return new Promise((resolve, reject) => {
    const tool = spawn('reg.exe', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    tool.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    tool.once('error', reject);
    tool.once('close', (code) => {
      resolve({ code, output });
    });
  });
}

/** Tells whether a file or folder exists. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Opens a file the way a double-click does, through the program Windows has for its kind. */
function openAsDoubleClick(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const shell = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process -FilePath '${path}'`],
      { stdio: 'ignore' },
    );
    shell.once('error', reject);
    shell.once('close', () => {
      resolve();
    });
  });
}

test('asks its two choices at the first launch of the portable version, then opens a double-clicked project file and gives the files back from its settings', async () => {
  skipUnlessRequired(
    process.platform !== 'win32',
    'Only Windows opens files through the registry.',
  );
  const taken = await Promise.all(
    TASKLACE_KEYS.map(async (key) => (await registry(['query', key])).code === 0),
  );
  skipUnlessRequired(
    taken.includes(true) || (await exists(DEFAULT_USER_DATA)),
    'This computer already has Tasklace set up; the test never changes it.',
  );
  const plan = join(userData, 'Double-clicked plan.tasklace');
  const named = { ...project([workTask('a')]), name: 'Double-clicked plan' };
  const document = createSharedDocument(named, requireDocumentId(crypto.randomUUID()));
  await writeFile(plan, encodeTasklaceFile(document, zlibCompressor));
  try {
    const { page } = await start({
      ownFolder: false,
      env: { PORTABLE_EXECUTABLE_FILE: win32.normalize(EXECUTABLE) },
    });
    const welcome = page.getByRole('dialog', { name: 'Welcome to Tasklace' });
    const check = welcome.getByRole('switch', { name: 'Check for new versions' });
    const associate = welcome.getByRole('switch', {
      name: 'Open Tasklace files and links with this copy',
    });
    await expect(associate).toHaveAttribute('aria-checked', 'true');
    await expect(check).toHaveAttribute('aria-checked', 'true');
    await check.click();
    await welcome.getByRole('button', { name: 'Continue' }).click();
    await expect(welcome).toBeHidden();
    await expect
      .poll(
        async () =>
          /REG_SZ\s+(.*?)\r?$/m.exec((await registry(['query', COMMAND_KEY, '/ve'])).output)?.[1],
        { timeout: SAVE_WAIT_MS },
      )
      .toBe(`"${win32.normalize(EXECUTABLE)}" -- "%1"`);
    await expect(page.getByText('Tasklace could not keep these choices')).toHaveCount(0);
    expect(
      JSON.parse(await readFile(join(DEFAULT_USER_DATA, 'update-check.json'), 'utf8')),
    ).toEqual({ version: 1, settings: { checkForNewVersions: false, lastCheckedOn: null } });
    await openAsDoubleClick(plan);
    await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue(
      'Double-clicked plan',
    );
    await page.getByRole('button', { name: 'Tasklace', exact: true }).click();
    await page.getByRole('menuitem', { name: /Tasklace settings…/ }).click();
    const settings = page.getByRole('dialog', { name: 'Tasklace settings' });
    const files = settings.getByRole('switch', {
      name: 'Open Tasklace files and links with this copy',
    });
    await expect(files).toHaveAttribute('aria-checked', 'true');
    await files.click();
    await expect(files).toHaveAttribute('aria-checked', 'false');
    await expect
      .poll(async () => (await registry(['query', COMMAND_KEY])).code, { timeout: SAVE_WAIT_MS })
      .toBe(1);
  } finally {
    if (running !== null) {
      await running.browser.close().catch(() => undefined);
      await stopProcessTree(running.child);
      running = null;
    }
    for (const key of TASKLACE_KEYS) {
      await registry(['delete', key, '/f']);
    }
    await rm(DEFAULT_USER_DATA, {
      recursive: true,
      force: true,
      maxRetries: REMOVAL_RETRIES,
      retryDelay: REMOVAL_RETRY_STEP_MS,
    });
  }
});
