import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { connectToWindow, freePort } from './connection';

const EXECUTABLE = process.env['TASKLACE_PACKAGED_APP'] ?? '';
const DESKTOP_FILE = '/usr/share/applications/tasklace.desktop';
const DESKTOP_NAME = 'tasklace.desktop';
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
  test.skip(
    process.env['TASKLACE_INSTALLED_PACKAGE'] !== '1',
    'Only a computer with the package installed runs this test.',
  );
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
    running.child.kill('SIGKILL');
    running = null;
  }
  if (configFolder !== '') {
    await rm(configFolder, { recursive: true, force: true });
    configFolder = '';
  }
});

/** Gives the environment in which the application and the desktop tools share one folder of settings, which the single instance of the application goes by. */
function sharedEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, XDG_CONFIG_HOME: configFolder };
}

/** Starts the installed application with its sandbox on and connects to its window. */
async function start(): Promise<Page> {
  const port = await freePort();
  const child = spawn(EXECUTABLE, [`--remote-debugging-port=${String(port)}`], {
    stdio: 'ignore',
    env: sharedEnvironment(),
  });
  const connected = await connectToWindow(port);
  if (connected === null) {
    child.kill('SIGKILL');
    throw new Error('The installed application did not open its window.');
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

test('declares its files and links to the desktop, keeping the separator before what it is given', async () => {
  const entry = await readFile(DESKTOP_FILE, 'utf8');
  expect(entry.split('\n').filter((line) => /^(Exec|MimeType|Categories)=/.test(line))).toEqual([
    'Exec=/opt/Tasklace/tasklace -- %U',
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
