import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain as electronIpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type BridgeResult } from '../../preload/bridge-contract';
import type { AssociationOwner, FileAssociations } from '../platform/file-associations';
import { INSTALLER_CHOICES_KEY } from '../platform/installer-choices';
import { registryFileText, RegistryToolError, type Registry } from '../platform/registry';
import {
  isWindowsExecutablePath,
  type CopyKind,
  type WindowsExecutablePath,
} from '../platform/this-copy';
import type { FakeIpcMain } from '../testing/fake-electron';
import {
  readWelcomeChoices,
  registerSetupHandlers,
  type Setup,
  type ThisCopy,
} from './setup-service';

vi.mock('electron', async () => {
  const fakes = await import('../testing/fake-electron');
  return { ipcMain: new fakes.FakeIpcMain() };
});

const ipcMain = electronIpcMain as unknown as FakeIpcMain;
const EXECUTABLE = windowsPath('C:\\Users\\Lea\\Downloads\\Tasklace-0.1.0-portable.exe');
const FORMER = windowsPath('C:\\Users\\Lea\\Desktop\\Tasklace-0.1.0-portable.exe');
const ELSEWHERE = windowsPath('D:\\Tools\\Tasklace.exe');
const TOOL_FAILURE = new RegistryToolError('import', { exitCode: 5, errorOutput: '' });
const KEPT: BridgeResult<null> = { ok: true, value: null };
const NOT_KEPT: BridgeResult<null> = { ok: false, error: { code: 'WRITE_FAILED' } };
const CHOICES = { associate: true, checkForNewVersions: false };

type Operation = 'owner' | 'register' | 'unregister' | 'export' | 'delete';

interface FakeCopy {
  readonly copy: ThisCopy;
  owner: AssociationOwner;
  installerChoices: string | null;
  readonly failures: Map<Operation, Error>;
  readonly actions: string[];
}

let folder = '';
let storePath = '';
let checks: boolean[] = [];
let checkResult: BridgeResult<null> = KEPT;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-setup-'));
  storePath = join(folder, 'setup.json');
  checks = [];
  checkResult = KEPT;
  ipcMain.handlers.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

/** Gives a Windows path the tests know to be valid as the executable of a copy. */
function windowsPath(path: string): WindowsExecutablePath {
  if (!isWindowsExecutablePath(path)) {
    throw new Error(`${path} is not a path an executable can have.`);
  }
  return path;
}

/** Builds a copy of Tasklace whose registry and files are fakes that record what they are asked and fail as the test says. */
function fakeCopy(kind: CopyKind, owner: AssociationOwner = { kind: 'none' }): FakeCopy {
  const failures = new Map<Operation, Error>();
  const actions: string[] = [];
  /** Records an operation, or fails it with the failure set for the test. */
  const run = (operation: Operation, detail = ''): Promise<void> => {
    const failure = failures.get(operation);
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    actions.push(`${operation}${detail}`);
    return Promise.resolve();
  };
  const fake: FakeCopy = {
    owner,
    installerChoices: null,
    failures,
    actions,
    copy: {
      kind,
      executable: EXECUTABLE,
      registry: {
        exportKey: async (key) => {
          await run('export', ` ${key}`);
          return key === INSTALLER_CHOICES_KEY ? fake.installerChoices : null;
        },
        importText: () => Promise.reject(new Error('The setup never imports registry files.')),
        deleteKey: async (key) => {
          await run('delete', ` ${key}`);
          fake.installerChoices = null;
        },
      } satisfies Registry,
      associations: {
        owner: async () => {
          const failure = failures.get('owner');
          if (failure !== undefined) {
            throw failure;
          }
          return Promise.resolve(fake.owner);
        },
        register: async () => {
          await run('register');
          fake.owner = { kind: 'thisCopy' };
        },
        unregister: async () => {
          await run('unregister');
          fake.owner = { kind: 'none' };
        },
      } satisfies FileAssociations,
    },
  };
  return fake;
}

/** Registers the channels of the setup for a copy, built unless told otherwise. */
function register(copy: ThisCopy | null, isPackaged = true): Setup {
  return registerSetupHandlers({
    assertTrusted: () => undefined,
    storePath,
    isPackaged,
    copy,
    setCheck: (check) => {
      checks.push(check);
      return Promise.resolve(checkResult);
    },
  });
}

/** Asks a channel as the page would. */
async function ask(channel: string, ...values: unknown[]): Promise<unknown> {
  return await Promise.resolve(ipcMain.invoke(channel, { sender: {} }, ...values));
}

/** Reads what the store of the setup holds, or null when nothing was stored. */
async function stored(): Promise<unknown> {
  return readFile(storePath, 'utf8').then(
    (text) => JSON.parse(text) as unknown,
    () => null,
  );
}

/** Writes what the store of the setup holds. */
async function storeSetup(welcomed: boolean, registeredExecutable: string | null): Promise<void> {
  await writeFile(
    storePath,
    JSON.stringify({ version: 1, settings: { welcomed, registeredExecutable } }),
  );
}

/** Writes the choices of the installer as the registry tool exports them. */
function installerChoices(associate: number, check: number): string {
  return registryFileText([
    `[${INSTALLER_CHOICES_KEY}]`,
    `"Associate"=dword:0000000${String(associate)}`,
    `"CheckForNewVersions"=dword:0000000${String(check)}`,
  ]);
}

/** Gives the setup as the page asks for it. */
async function state(): Promise<unknown> {
  return ask(IPC_CHANNELS.setupState);
}

describe('readWelcomeChoices', () => {
  it('reads exactly the two choices of the welcome window', () => {
    expect(readWelcomeChoices(CHOICES)).toEqual(CHOICES);
    for (const value of [
      null,
      'yes',
      { associate: true },
      { associate: true, checkForNewVersions: 'no' },
      { associate: 1, checkForNewVersions: true },
      { associate: true, checkForNewVersions: true, extra: true },
      { associate: true, check: true },
    ]) {
      expect(readWelcomeChoices(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('a copy that is not built', () => {
  it('shows no welcome, never allows a check at launch and refuses to change anything', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const setup = register(null, false);
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: false, association: { kind: 'unavailable' } },
    });
    expect(await setup.mayCheckAtLaunch()).toBe(false);
    const refused = { ok: false, error: { code: 'TASK_FAILED' } };
    expect(await ask(IPC_CHANNELS.finishWelcome, CHOICES)).toEqual(refused);
    expect(await ask(IPC_CHANNELS.setFileAssociation, true)).toEqual(refused);
    expect(error.mock.calls).toEqual([
      ['The page asked to finish a welcome that was not shown, or with other choices:', CHOICES],
      ['The page asked to change which copy opens project files with:', true],
    ]);
    expect(checks).toEqual([]);
  });
});

describe('a built copy that cannot open files', () => {
  it('asks the choice about new versions in its welcome, leaving the files aside', async () => {
    const setup = register(null);
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: true, association: { kind: 'unavailable' } },
    });
    expect(await setup.mayCheckAtLaunch()).toBe(false);
    expect(await ask(IPC_CHANNELS.finishWelcome, CHOICES)).toEqual({
      ok: true,
      value: { kind: 'unavailable' },
    });
    expect([checks, await setup.mayCheckAtLaunch(), await stored()]).toEqual([
      [false],
      true,
      { version: 1, settings: { welcomed: true, registeredExecutable: null } },
    ]);
  });
});

describe('the portable version', () => {
  it('asks its choices once at its first launch, allowing the check only once its choice is applied', async () => {
    const fake = fakeCopy('portable');
    const setup = register(fake.copy);
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    });
    expect(await setup.mayCheckAtLaunch()).toBe(false);
    expect(await ask(IPC_CHANNELS.finishWelcome, CHOICES)).toEqual({
      ok: true,
      value: { kind: 'thisCopy' },
    });
    expect([await setup.mayCheckAtLaunch(), checks, fake.actions]).toEqual([
      true,
      [false],
      ['register'],
    ]);
    expect(await stored()).toEqual({
      version: 1,
      settings: { welcomed: true, registeredExecutable: EXECUTABLE },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await ask(IPC_CHANNELS.finishWelcome, CHOICES)).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    ipcMain.handlers.clear();
    const relaunched = register(fake.copy);
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: false, association: { kind: 'thisCopy' } },
    });
    expect(await relaunched.mayCheckAtLaunch()).toBe(true);
  });

  it('registers nothing when the person does not want this copy to open files', async () => {
    const fake = fakeCopy('portable', { kind: 'otherCopy', path: ELSEWHERE });
    register(fake.copy);
    expect(
      await ask(IPC_CHANNELS.finishWelcome, { associate: false, checkForNewVersions: true }),
    ).toEqual({ ok: true, value: { kind: 'otherCopy', path: ELSEWHERE } });
    expect([checks, fake.actions]).toEqual([[true], []]);
    expect(await stored()).toEqual({
      version: 1,
      settings: { welcomed: true, registeredExecutable: null },
    });
  });

  it('keeps the welcome open on choices of another shape', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const setup = register(fakeCopy('portable').copy);
    expect(await ask(IPC_CHANNELS.finishWelcome, { associate: 'yes' })).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    });
    expect(await setup.mayCheckAtLaunch()).toBe(false);
    expect(error.mock.calls).toEqual([
      [
        'The page asked to finish a welcome that was not shown, or with other choices:',
        { associate: 'yes' },
      ],
    ]);
  });

  it('never allows a check when the choice about new versions cannot be kept, and asks again at the next launch', async () => {
    const fake = fakeCopy('portable');
    const setup = register(fake.copy);
    checkResult = NOT_KEPT;
    expect(await ask(IPC_CHANNELS.finishWelcome, CHOICES)).toEqual(NOT_KEPT);
    expect([await setup.mayCheckAtLaunch(), fake.actions, await stored()]).toEqual([
      false,
      [],
      null,
    ]);
    ipcMain.handlers.clear();
    checkResult = KEPT;
    register(fake.copy);
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    });
  });

  it('reports files it could not register, the choice about new versions being applied', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeCopy('portable');
    fake.failures.set('register', TOOL_FAILURE);
    const setup = register(fake.copy);
    expect(await ask(IPC_CHANNELS.finishWelcome, CHOICES)).toEqual({
      ok: false,
      error: { code: 'WRITE_FAILED' },
    });
    expect([await setup.mayCheckAtLaunch(), checks]).toEqual([true, [false]]);
    expect(error.mock.calls).toEqual([
      ['The choices of the welcome window could not all be applied:', TOOL_FAILURE],
    ]);
  });

  it('keeps opening files when it moved, never taking them from another copy, a failure being only logged', async () => {
    const moved = fakeCopy('portable', {
      kind: 'otherCopy',
      path: windowsPath(FORMER.toUpperCase()),
    });
    await storeSetup(true, FORMER);
    const setup = register(moved.copy);
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: false, association: { kind: 'thisCopy' } },
    });
    expect([moved.actions, await setup.mayCheckAtLaunch()]).toEqual([['register'], true]);
    expect(await stored()).toEqual({
      version: 1,
      settings: { welcomed: true, registeredExecutable: EXECUTABLE },
    });
    for (const owner of [{ kind: 'otherCopy', path: ELSEWHERE }, { kind: 'none' }] as const) {
      ipcMain.handlers.clear();
      await storeSetup(true, FORMER);
      const other = fakeCopy('portable', owner);
      register(other.copy);
      expect(await state()).toEqual({ ok: true, value: { welcome: false, association: owner } });
      expect(other.actions).toEqual([]);
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ipcMain.handlers.clear();
    await storeSetup(true, FORMER);
    const failing = fakeCopy('portable', { kind: 'otherCopy', path: FORMER });
    failing.failures.set('register', TOOL_FAILURE);
    const kept = register(failing.copy);
    expect(await kept.mayCheckAtLaunch()).toBe(true);
    expect(error.mock.calls).toEqual([
      ['This copy moved, but could not keep opening project files:', TOOL_FAILURE],
    ]);
  });

  it('asks again when its setup cannot be read, never supposing a choice', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await writeFile(storePath, '{}');
    const fake = fakeCopy('portable');
    const setup = registerSetupHandlers({
      assertTrusted: () => undefined,
      storePath: join(storePath, 'inside'),
      isPackaged: true,
      copy: fake.copy,
      setCheck: () => Promise.resolve(KEPT),
    });
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    });
    expect(await setup.mayCheckAtLaunch()).toBe(false);
    expect(error.mock.calls).toEqual([
      [
        'The setup of Tasklace could not be read, so its choices are asked again:',
        expect.objectContaining({ code: 'ENOTDIR' }),
      ],
    ]);
  });
});

describe('the installed version', () => {
  it('applies once the choices its installer left, then removes them', async () => {
    const fake = fakeCopy('installed');
    fake.installerChoices = installerChoices(1, 0);
    const setup = register(fake.copy);
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: false, association: { kind: 'thisCopy' } },
    });
    expect([await setup.mayCheckAtLaunch(), checks, fake.actions]).toEqual([
      true,
      [false],
      [`export ${INSTALLER_CHOICES_KEY}`, 'register', `delete ${INSTALLER_CHOICES_KEY}`],
    ]);
    expect(await stored()).toEqual({
      version: 1,
      settings: { welcomed: true, registeredExecutable: EXECUTABLE },
    });
  });

  it('registers nothing more when it already opens files, or when the person declined', async () => {
    const registered = fakeCopy('installed', { kind: 'thisCopy' });
    registered.installerChoices = installerChoices(1, 1);
    register(registered.copy);
    await state();
    expect([checks, registered.actions]).toEqual([
      [true],
      [`export ${INSTALLER_CHOICES_KEY}`, `delete ${INSTALLER_CHOICES_KEY}`],
    ]);
    ipcMain.handlers.clear();
    await rm(storePath);
    const declined = fakeCopy('installed');
    declined.installerChoices = installerChoices(0, 0);
    register(declined.copy);
    await state();
    expect(declined.actions).toEqual([
      `export ${INSTALLER_CHOICES_KEY}`,
      `delete ${INSTALLER_CHOICES_KEY}`,
    ]);
    expect(await stored()).toEqual({
      version: 1,
      settings: { welcomed: true, registeredExecutable: null },
    });
  });

  it('keeps the choices of the installer and allows no check when its choice about new versions cannot be kept', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    checkResult = NOT_KEPT;
    const fake = fakeCopy('installed');
    fake.installerChoices = installerChoices(1, 0);
    const setup = register(fake.copy);
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: false, association: { kind: 'none' } },
    });
    expect([await setup.mayCheckAtLaunch(), fake.actions, fake.installerChoices]).toEqual([
      false,
      [`export ${INSTALLER_CHOICES_KEY}`],
      installerChoices(1, 0),
    ]);
    expect(error.mock.calls).toEqual([
      [
        'The choice of the installer about new versions could not be kept; it is applied at the next launch.',
      ],
    ]);
  });

  it('keeps the choices of the installer for the next launch when the files cannot be registered or the choices removed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const operation of ['register', 'delete'] as const) {
      ipcMain.handlers.clear();
      const fake = fakeCopy('installed');
      fake.installerChoices = installerChoices(1, 1);
      fake.failures.set(operation, TOOL_FAILURE);
      const setup = register(fake.copy);
      expect(await setup.mayCheckAtLaunch()).toBe(true);
      expect(fake.installerChoices).toBe(installerChoices(1, 1));
    }
    expect(error.mock.calls).toEqual([
      [
        'The choices of the installer could not all be applied; they are applied again at the next launch:',
        TOOL_FAILURE,
      ],
      [
        'The choices of the installer could not all be applied; they are applied again at the next launch:',
        TOOL_FAILURE,
      ],
    ]);
  });

  it('asks its choices when its installer left none, as after an installation for every user, and follows a move', async () => {
    const fresh = fakeCopy('installed');
    const asking = register(fresh.copy);
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    });
    expect(await asking.mayCheckAtLaunch()).toBe(false);
    ipcMain.handlers.clear();
    const moved = fakeCopy('installed', { kind: 'otherCopy', path: FORMER });
    await storeSetup(true, FORMER);
    const setup = register(moved.copy);
    expect(await setup.mayCheckAtLaunch()).toBe(true);
    expect(moved.actions).toEqual([`export ${INSTALLER_CHOICES_KEY}`, 'register']);
  });

  it('asks its choices when the choices of its installer cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeCopy('installed');
    fake.failures.set('export', TOOL_FAILURE);
    const setup = register(fake.copy);
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    });
    expect(await setup.mayCheckAtLaunch()).toBe(false);
    expect(error.mock.calls).toEqual([
      ['The setup of Tasklace could not be read, so its choices are asked again:', TOOL_FAILURE],
    ]);
  });

  it('logs an error of the program while preparing, then asks the choices of a built copy', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fault = new TypeError('a fault of the program');
    const fake = fakeCopy('installed');
    fake.failures.set('export', fault);
    const setup = register(fake.copy);
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    });
    expect(await setup.mayCheckAtLaunch()).toBe(false);
    expect(error.mock.calls).toEqual([['The setup of Tasklace failed unexpectedly:', fault]]);
  });

  it('answers whether a check may run only once the setup is prepared', async () => {
    const fake = fakeCopy('installed');
    fake.installerChoices = installerChoices(0, 1);
    let release: () => void = () => undefined;
    const exported = fake.copy.registry.exportKey;
    const slow: Registry = {
      ...fake.copy.registry,
      exportKey: async (key) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return exported(key);
      },
    };
    const setup = register({ ...fake.copy, registry: slow });
    let answer: boolean | null = null;
    const asking = setup.mayCheckAtLaunch().then((value) => {
      answer = value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answer).toBeNull();
    release();
    await asking;
    expect(answer).toBe(true);
  });
});

describe('the switch of the settings', () => {
  it('makes this copy open files and links, and stops it only when it opens them', async () => {
    const fake = fakeCopy('installed', { kind: 'otherCopy', path: ELSEWHERE });
    await storeSetup(true, null);
    register(fake.copy);
    expect(await ask(IPC_CHANNELS.setFileAssociation, false)).toEqual({
      ok: true,
      value: { kind: 'otherCopy', path: ELSEWHERE },
    });
    expect(await ask(IPC_CHANNELS.setFileAssociation, true)).toEqual({
      ok: true,
      value: { kind: 'thisCopy' },
    });
    expect(await stored()).toEqual({
      version: 1,
      settings: { welcomed: true, registeredExecutable: EXECUTABLE },
    });
    expect(await ask(IPC_CHANNELS.setFileAssociation, false)).toEqual({
      ok: true,
      value: { kind: 'none' },
    });
    expect(fake.actions).toEqual([`export ${INSTALLER_CHOICES_KEY}`, 'register', 'unregister']);
    expect(await stored()).toEqual({
      version: 1,
      settings: { welcomed: true, registeredExecutable: null },
    });
  });

  it('refuses a value that is not on or off, and reports a registry that refuses the change', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeCopy('installed');
    await storeSetup(true, null);
    register(fake.copy);
    expect(await ask(IPC_CHANNELS.setFileAssociation, 'on')).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    fake.failures.set('register', TOOL_FAILURE);
    expect(await ask(IPC_CHANNELS.setFileAssociation, true)).toEqual({
      ok: false,
      error: { code: 'WRITE_FAILED' },
    });
    expect(error.mock.calls).toEqual([
      ['The page asked to change which copy opens project files with:', 'on'],
      ['The copy that opens project files could not be changed:', TOOL_FAILURE],
    ]);
  });

  it('tells which copy opens files is unknown when the registry cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeCopy('installed');
    await storeSetup(true, null);
    register(fake.copy);
    fake.failures.set('owner', TOOL_FAILURE);
    expect(await state()).toEqual({
      ok: true,
      value: { welcome: false, association: { kind: 'unknown' } },
    });
    expect(error.mock.calls).toEqual([
      ['Tasklace could not find out which copy opens project files:', TOOL_FAILURE],
    ]);
  });

  it('lets an error of the program through rather than reporting it as a refused change', async () => {
    const fake = fakeCopy('installed');
    await storeSetup(true, null);
    register(fake.copy);
    await state();
    fake.failures.set('register', new TypeError('a fault of the program'));
    await expect(ask(IPC_CHANNELS.setFileAssociation, true)).rejects.toThrow(
      'a fault of the program',
    );
    fake.failures.set('owner', new TypeError('another fault'));
    await expect(state()).rejects.toThrow('another fault');
  });
});
