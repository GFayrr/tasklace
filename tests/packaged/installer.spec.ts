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
const UNINSTALL_PATH = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const UNINSTALL_KEYS = [`HKCU\\${UNINSTALL_PATH}`, `HKLM\\${UNINSTALL_PATH}`];
const REG_NOTHING_FOUND = 1;
const UNINSTALLER = 'Uninstall Tasklace.exe';
const REMOVAL_RETRIES = 10;
const REMOVAL_RETRY_STEP_MS = 200;

let folder = '';
const installed = new Set<string>();

test.beforeEach(async () => {
  skipUnlessRequired(process.platform !== 'win32', 'Only Windows runs the installer.');
  const taken = await Promise.all(TASKLACE_KEYS.map(keyExists));
  skipUnlessRequired(
    taken.includes(true) || (await uninstallEntries('Tasklace')).length > 0,
    'This computer already has Tasklace set up; the test never changes it.',
  );
  folder = await mkdtemp(join(tmpdir(), 'tasklace-installer-'));
});

test.afterEach(async () => {
  if (folder === '') {
    return;
  }
  const leftFolder = folder;
  const leftInstallations = [...installed];
  folder = '';
  installed.clear();
  await runEveryStep([
    ...leftInstallations.map((target) => () => removeInstallation(target)),
    ...TASKLACE_KEYS.map((key) => () => removeKey(key)),
    () =>
      rm(leftFolder, {
        recursive: true,
        force: true,
        maxRetries: REMOVAL_RETRIES,
        retryDelay: REMOVAL_RETRY_STEP_MS,
      }),
  ]);
});

/** Runs every step of a cleaning, even after one failed, and then reports all the failures together. */
async function runEveryStep(steps: readonly (() => Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    await step().catch((failure: unknown) => {
      failures.push(failure);
    });
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'The installer test could not clean up after itself.');
  }
}

/** Runs a program to its end and gives its exit code, its output and what it wrote as errors. */
function run(
  program: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly output: string; readonly errors: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, output, errors });
    });
  });
}

/** Runs a program that must succeed, and fails with what it said when it does not. */
async function runToSuccess(program: string, args: readonly string[]): Promise<void> {
  const { code, errors } = await run(program, args);
  if (code !== 0) {
    throw new Error(`${program} ${args.join(' ')} ended with ${String(code)}: ${errors}`);
  }
}

/** Tells whether a registry key exists. */
async function keyExists(key: string): Promise<boolean> {
  return (await run('reg.exe', ['query', key])).code === 0;
}

/** Removes a registry key if it exists. */
async function removeKey(key: string): Promise<void> {
  if (await keyExists(key)) {
    await runToSuccess('reg.exe', ['delete', key, '/f']);
  }
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

/** Tells whether a file is there, anything but its proven absence counting as there, since Windows refuses access to a file being deleted. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    (failure: unknown) =>
      !(failure instanceof Error && 'code' in failure && failure.code === 'ENOENT'),
  );
}

/** Installs Tasklace silently for the current user in a folder of the test, with the options given, and gives the folder. */
async function install(options: readonly string[]): Promise<string> {
  const target = win32.join(folder, 'Tasklace');
  installed.add(target);
  await runToSuccess(await installer(), ['/S', ...options, `/D=${target}`]);
  await expect
    .poll(() => exists(win32.join(target, 'Tasklace.exe')), { timeout: INSTALL_WAIT_MS })
    .toBe(true);
  await expect.poll(() => entryCountOf(target), { timeout: INSTALL_WAIT_MS }).toBe(1);
  return target;
}

/** Lists the keys of the installed programs with a value whose data contain a text, failing when the registry cannot tell. */
async function uninstallEntries(text: string): Promise<readonly string[]> {
  const entries: string[] = [];
  for (const key of UNINSTALL_KEYS) {
    const { code, output, errors } = await run('reg.exe', ['query', key, '/s', '/f', text, '/d']);
    if ((code !== 0 && code !== REG_NOTHING_FOUND) || errors !== '') {
      throw new Error(`reg.exe could not search ${key}, ended with ${String(code)}: ${errors}`);
    }
    entries.push(...output.split(/\r?\n/).filter((line) => line.startsWith('HKEY_')));
  }
  return entries;
}

/** Lists the keys of the installed programs that name an installation, by the unique name of its test folder since Windows may shorten the rest of the path. */
function entriesOf(target: string): Promise<readonly string[]> {
  return uninstallEntries(win32.basename(win32.dirname(target)));
}

/** Counts the keys of the installed programs that name an installation. */
async function entryCountOf(target: string): Promise<number> {
  return (await entriesOf(target)).length;
}

/** Uninstalls Tasklace silently from its folder and waits until its program and its entry among the installed programs are gone, the uninstaller removing that entry only after the files. */
async function uninstall(target: string): Promise<void> {
  await run(win32.join(target, UNINSTALLER), ['/S']);
  await expect
    .poll(() => exists(win32.join(target, 'Tasklace.exe')), { timeout: INSTALL_WAIT_MS })
    .toBe(false);
  await expect.poll(() => entryCountOf(target), { timeout: INSTALL_WAIT_MS }).toBe(0);
}

/** Removes an installation a test left behind, and any entry an installation stopped halfway left without its uninstaller, so that the next test never sees an existing installation. */
async function removeInstallation(target: string): Promise<void> {
  if (await exists(win32.join(target, UNINSTALLER))) {
    await uninstall(target);
  }
  for (const entry of await entriesOf(target)) {
    await runToSuccess('reg.exe', ['delete', entry, '/f']);
  }
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
    await runToSuccess('taskkill', ['/pid', String(app.pid), '/t', '/f']);
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
  await runToSuccess('reg.exe', ['add', COMMAND_KEY, '/ve', '/d', `"${OTHER_COPY}" -- "%1"`, '/f']);
  await uninstall(target);
  expect(await defaultText(COMMAND_KEY)).toBe(`"${OTHER_COPY}" -- "%1"`);
  expect((await run('reg.exe', ['query', SETUP_KEY])).code).toBe(1);
});

test('installed again over an existing installation, shows no page and writes no choice, keeping those made since', async () => {
  const target = await install(['/NOUPDATECHECK']);
  expect([await choice('Associate'), await choice('CheckForNewVersions')]).toEqual([1, 0]);
  await runToSuccess('reg.exe', ['delete', SETUP_KEY, '/f']);
  await install(['/NOASSOCIATE']);
  expect([await choice('Associate'), await choice('CheckForNewVersions')]).toEqual([null, null]);
  await uninstall(target);
});
