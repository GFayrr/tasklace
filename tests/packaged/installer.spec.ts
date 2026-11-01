import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { expect, test } from '@playwright/test';
import { skipUnlessRequired } from './windows-checks';

const EXECUTABLE = process.env['TASKLACE_PACKAGED_APP'] ?? '';
const INSTALL_WAIT_MS = 60_000;
const SETUP_KEY = 'HKCU\\Software\\Tasklace\\Setup';
const CLASSES = 'HKCU\\Software\\Classes';
const COMMAND_KEY = `${CLASSES}\\Tasklace.Project\\shell\\open\\command`;
const TASKLACE_KEYS = [
  `${CLASSES}\\Tasklace.Project`,
  `${CLASSES}\\tasklace`,
  `${CLASSES}\\.tasklace`,
  'HKCU\\Software\\Tasklace',
];
const OTHER_COPY = 'C:\\Other\\Tasklace-0.1.0-portable.exe';
const REMOVAL_RETRIES = 10;
const REMOVAL_RETRY_STEP_MS = 200;

let folder = '';

test.beforeEach(async () => {
  skipUnlessRequired(process.platform !== 'win32', 'Only Windows runs the installer.');
  const taken = await Promise.all(
    TASKLACE_KEYS.map(async (key) => (await run('reg.exe', ['query', key])).code === 0),
  );
  skipUnlessRequired(
    taken.includes(true),
    'This computer already has Tasklace set up; the test never changes it.',
  );
  folder = await mkdtemp(join(tmpdir(), 'tasklace-installer-'));
});

test.afterEach(async () => {
  if (folder === '') {
    return;
  }
  for (const key of TASKLACE_KEYS) {
    await run('reg.exe', ['delete', key, '/f']);
  }
  await rm(folder, {
    recursive: true,
    force: true,
    maxRetries: REMOVAL_RETRIES,
    retryDelay: REMOVAL_RETRY_STEP_MS,
  });
  folder = '';
});

/** Runs a program to its end and gives its exit code and output. */
function run(
  program: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, output });
    });
  });
}

/** Finds the installer built beside the unpacked application. */
async function installer(): Promise<string> {
  const dist = dirname(dirname(EXECUTABLE));
  const [name] = (await readdir(dist)).filter((file) => file.endsWith('-setup.exe'));
  if (name === undefined) {
    throw new Error(`No installer was built in ${dist}.`);
  }
  return join(dist, name);
}

/** Tells whether a file exists. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Installs Tasklace silently for the current user in a folder of the test, with the options given, and gives the folder. */
async function install(options: readonly string[]): Promise<string> {
  const target = win32.join(folder, 'Tasklace');
  await run(await installer(), ['/S', ...options, `/D=${target}`]);
  await expect
    .poll(() => exists(win32.join(target, 'Tasklace.exe')), { timeout: INSTALL_WAIT_MS })
    .toBe(true);
  return target;
}

/** Uninstalls Tasklace silently from its folder and waits until its program is gone. */
async function uninstall(target: string): Promise<void> {
  await run(win32.join(target, 'Uninstall Tasklace.exe'), ['/S']);
  await expect
    .poll(() => exists(win32.join(target, 'Tasklace.exe')), { timeout: INSTALL_WAIT_MS })
    .toBe(false);
}

/** Reads a number the installer left among its choices, or null when it is not there. */
async function choice(name: string): Promise<number | null> {
  const { code, output } = await run('reg.exe', ['query', SETUP_KEY, '/v', name]);
  const match = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(output);
  return code === 0 && match !== null ? Number.parseInt(match[1] ?? '', 16) : null;
}

/** Reads the default text value of a key, or null when it has none. */
async function defaultText(key: string): Promise<string | null> {
  const { code, output } = await run('reg.exe', ['query', key, '/ve']);
  const match = /REG_(?:EXPAND_)?SZ\s+(.*?)\r?$/m.exec(output);
  return code === 0 && match !== null ? (match[1] ?? '') : null;
}

test('leaves the choices of its page for the first launch, which opens files with the installed copy, and removes them all when uninstalled', async () => {
  const target = await install(['/NOUPDATECHECK']);
  expect([await choice('Associate'), await choice('CheckForNewVersions')]).toEqual([1, 0]);
  const executable = win32.join(target, 'Tasklace.exe');
  const userData = join(folder, 'user-data');
  const app = spawn(executable, [`--user-data-dir=${userData}`], { stdio: 'ignore' });
  try {
    await expect
      .poll(() => defaultText(COMMAND_KEY), { timeout: INSTALL_WAIT_MS })
      .toBe(`"${executable}" -- "%1"`);
    expect(await defaultText(`${CLASSES}\\.tasklace`)).toBe('Tasklace.Project');
    await expect.poll(() => choice('Associate'), { timeout: INSTALL_WAIT_MS }).toBeNull();
  } finally {
    await run('taskkill', ['/pid', String(app.pid), '/t', '/f']);
  }
  await uninstall(target);
  for (const key of [COMMAND_KEY, `${CLASSES}\\tasklace`, 'HKCU\\Software\\Tasklace']) {
    expect((await run('reg.exe', ['query', key])).code, key).toBe(1);
  }
  expect(await defaultText(`${CLASSES}\\.tasklace`)).toBeNull();
  expect(await exists(userData)).toBe(true);
});

test('keeps the files of another copy and removes only its own choices when uninstalled', async () => {
  const target = await install(['/NOASSOCIATE', '/NOUPDATECHECK']);
  expect([await choice('Associate'), await choice('CheckForNewVersions')]).toEqual([0, 0]);
  await run('reg.exe', ['add', COMMAND_KEY, '/ve', '/d', `"${OTHER_COPY}" -- "%1"`, '/f']);
  await uninstall(target);
  expect(await defaultText(COMMAND_KEY)).toBe(`"${OTHER_COPY}" -- "%1"`);
  expect((await run('reg.exe', ['query', SETUP_KEY])).code).toBe(1);
});

test('installed again over an existing installation, shows no page and writes no choice, keeping those made since', async () => {
  const target = await install(['/NOUPDATECHECK']);
  expect([await choice('Associate'), await choice('CheckForNewVersions')]).toEqual([1, 0]);
  await run('reg.exe', ['delete', SETUP_KEY, '/f']);
  await install(['/NOASSOCIATE']);
  expect([await choice('Associate'), await choice('CheckForNewVersions')]).toEqual([null, null]);
  await uninstall(target);
});
