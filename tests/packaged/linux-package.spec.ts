import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { drawRelayAccess } from '../../src/core/collaboration/relay/relay-keys';
import { encodeRelayLink } from '../../src/core/collaboration/relay/relay-link';
import { encodeTasklaceFile } from '../../src/core/file/tasklace-file';
import { createSharedDocument, requireDocumentId } from '../../src/core/shared/shared-document';
import { project, workTask } from '../../src/core/testing/project-builder';
import { seededRandom } from '../../src/core/testing/test-crypto';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import { connectToWindow, freePort, watchEnding } from './connection';
import { skipUnlessInstalled } from './linux-checks';

const EXECUTABLE = process.env['TASKLACE_PACKAGED_APP'] ?? '';
const DESKTOP_FILE = '/usr/share/applications/tasklace.desktop';
const DESKTOP_NAME = 'tasklace.desktop';
const LARGEST_ICON = '/usr/share/icons/hicolor/512x512/apps/tasklace.png';
const SYSTEM_CALL_FILTER = 'Seccomp:\t2';
const NO_NEW_PRIVILEGES = 'NoNewPrivs:\t1';
const OWN_PROCESS_NAMESPACE = /^NSpid:\t\d+(\t\d+)+$/;
const REMOVAL_RETRIES = 8;
const REMOVAL_RETRY_STEP_MS = 256;
const PACKAGE_DEPENDENCIES = [
  'libasound2',
  'libgbm1',
  'libgtk-3-0',
  'libnotify4',
  'libnss3',
  'libxss1',
  'libxtst6',
  'xdg-utils',
  'libatspi2.0-0',
  'libuuid1',
  'libsecret-1-0',
  'desktop-file-utils',
];
const RELAY_LINK_SEED = 11;
const LINK = encodeRelayLink({
  address: { host: 'relay.school.example', port: null, path: '/' },
  access: drawRelayAccess(seededRandom(RELAY_LINK_SEED)),
});
const run = promisify(execFile);

interface Running {
  readonly child: ChildProcess;
  readonly browser: Browser;
  readonly page: Page;
}

let configFolder = '';
let running: Running | null = null;

test.beforeEach(async () => {
  skipUnlessInstalled();
  configFolder = await mkdtemp(join(tmpdir(), 'tasklace-package-'));
  const userData = join(configFolder, 'Tasklace');
  await mkdir(userData);
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
    await stopProcess(running.child);
    running = null;
  }
  if (configFolder !== '') {
    await rm(configFolder, {
      recursive: true,
      force: true,
      maxRetries: REMOVAL_RETRIES,
      retryDelay: REMOVAL_RETRY_STEP_MS,
    });
    configFolder = '';
  }
});

/** Stops a process and waits until it has ended, so that it no longer holds its folders. */
async function stopProcess(child: ChildProcess): Promise<void> {
  const ended = child.exitCode !== null || child.signalCode !== null;
  child.kill('SIGKILL');
  if (!ended) {
    await once(child, 'exit');
  }
}

/** Gives the environment in which the application and the desktop tools share one folder of settings, which the single instance of the application goes by. */
function sharedEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, XDG_CONFIG_HOME: configFolder };
}

/** Starts the installed application with its sandbox on and connects to its window. */
async function start(): Promise<Page> {
  const port = await freePort();
  const child = spawn(EXECUTABLE, [`--remote-debugging-port=${String(port)}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: sharedEnvironment(),
  });
  const ending = watchEnding(child);
  const connected = await connectToWindow(port, child);
  if (connected === null) {
    await stopProcess(child);
    throw new Error(`The installed application did not open its window. ${ending()}`);
  }
  running = { child, ...connected };
  await expect(connected.page.locator('#app')).toHaveAttribute('data-started', 'true');
  return connected.page;
}

/** Writes a small project named after its file and gives its path. */
async function writeProject(name: string): Promise<string> {
  const path = join(configFolder, `${name}.tasklace`);
  const named = { ...project([workTask('a')]), name };
  const document = createSharedDocument(named, requireDocumentId(crypto.randomUUID()));
  await writeFile(path, encodeTasklaceFile(document, zlibCompressor));
  return path;
}

/** Opens a file or a link as a double-click on the desktop does. */
async function openOnDesktop(value: string): Promise<void> {
  await run('gio', ['open', value], { env: sharedEnvironment() });
}

/** Gives the arguments of every process of the application, by process number, Chromium writing those of its children as one text. */
async function applicationProcesses(): Promise<readonly (readonly [string, string[]])[]> {
  const numbers = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
  const processes = await Promise.all(
    numbers.map(async (pid) => {
      const line = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      return [pid, line.replaceAll('\0', ' ').trimEnd().split(' ')] as const;
    }),
  );
  return processes.filter(([, words]) => words[0] === EXECUTABLE);
}

test('asks for every library the application needs and shows up valid on the desktop', async () => {
  const { stdout: depends } = await run('dpkg-query', [
    '--show',
    '--showformat=${Depends}',
    'tasklace',
  ]);
  expect(depends.split(', ')).toEqual(PACKAGE_DEPENDENCIES);
  await run('desktop-file-validate', [DESKTOP_FILE]);
  await access(LARGEST_ICON);
});

test('runs every page in the sandbox of Chromium, under the AppArmor profile of the package', async () => {
  const page = await start();
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
  const processes = await applicationProcesses();
  expect(processes.filter(([, words]) => words.includes('--no-sandbox'))).toEqual([]);
  const renderers = processes.filter(([, words]) => words.includes('--type=renderer'));
  expect(renderers).not.toEqual([]);
  for (const [pid] of renderers) {
    const status = (await readFile(`/proc/${pid}/status`, 'utf8')).split('\n');
    expect(status).toEqual(expect.arrayContaining([SYSTEM_CALL_FILTER, NO_NEW_PRIVILEGES]));
    expect(status.find((line) => line.startsWith('NSpid:'))).toMatch(OWN_PROCESS_NAMESPACE);
  }
  const pid = String(running?.child.pid);
  const profile = await readFile(`/proc/${pid}/attr/current`, 'utf8');
  expect(profile.replace(/[\0\n]+$/, '')).toBe('tasklace (unconfined)');
});

test('asks only about new versions on a first launch, the package opening files on its own', async () => {
  const userData = join(configFolder, 'Tasklace');
  await rm(join(userData, 'setup.json'));
  await rm(join(userData, 'update-check.json'));
  const page = await start();
  const welcome = page.getByRole('dialog', { name: 'Welcome to Tasklace' });
  await expect(welcome.getByText('One choice for this computer.', { exact: false })).toBeVisible();
  await expect(welcome.getByRole('switch')).toHaveCount(1);
  await welcome.getByRole('switch').click();
  await welcome.getByRole('button', { name: 'Continue' }).click();
  await expect(welcome).toBeHidden();
  const settings: unknown = JSON.parse(await readFile(join(userData, 'update-check.json'), 'utf8'));
  expect(settings).toMatchObject({ settings: { checkForNewVersions: false } });
});

test('declares its files and links to the desktop, keeping the separator before what it is given', async () => {
  const entry = await readFile(DESKTOP_FILE, 'utf8');
  expect(
    entry
      .split('\n')
      .filter((line) => /^(Name|Exec|Icon|StartupWMClass|MimeType|Categories)=/.test(line)),
  ).toEqual([
    'Name=Tasklace',
    'Exec=/opt/Tasklace/tasklace -- %U',
    'Icon=tasklace',
    'StartupWMClass=tasklace',
    'MimeType=x-scheme-handler/tasklace;application/x-tasklace;',
    'Categories=Office;',
  ]);
  const file = await writeProject('Thesis');
  const { stdout: type } = await run('gio', ['info', '-a', 'standard::content-type', file]);
  expect(type.split('\n').map((line) => line.trim())).toContain(
    'standard::content-type: application/x-tasklace',
  );
  for (const kind of ['application/x-tasklace', 'x-scheme-handler/tasklace']) {
    const { stdout } = await run('gio', ['mime', kind]);
    expect(stdout.split('\n').map((line) => line.trim())).toContain(DESKTOP_NAME);
  }
});

test('opens a project file and fills the join window with a link from the desktop, its sandbox on', async () => {
  const page = await start();
  await openOnDesktop(await writeProject('Mes plans 2'));
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Mes plans 2');
  await openOnDesktop(LINK);
  const joinWindow = page.getByRole('dialog', { name: 'Join a shared plan' });
  await expect(joinWindow.getByRole('textbox', { name: 'Link you received' })).toHaveValue(LINK);
});
