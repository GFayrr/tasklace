import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain as electronIpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type BridgeResult } from '../../preload/bridge-contract';
import type { AssociationOwner, FileAssociations } from '../platform/file-associations';
import { registryFileText, RegistryToolError, type Registry } from '../platform/registry';
import type { FakeIpcMain } from '../testing/fake-electron';
import {
  INSTALLER_CHOICES_KEY,
  readWelcomeChoices,
  registerSetupHandlers,
  type CopyKind,
  type Setup,
  type ThisCopy,
} from './setup-service';

vi.mock('electron', async () => {
  const fakes = await import('../testing/fake-electron');
  return { ipcMain: new fakes.FakeIpcMain() };
});

const ipcMain = electronIpcMain as unknown as FakeIpcMain;
const EXECUTABLE = 'C:\\Users\\Lea\\Downloads\\Tasklace-0.1.0-portable.exe';
const FORMER = 'C:\\Users\\Lea\\Desktop\\Tasklace-0.1.0-portable.exe';
const ELSEWHERE = 'D:\\Tools\\Tasklace.exe';
const TOOL_FAILURE = new RegistryToolError('import', 5);

interface FakeCopy {
  readonly copy: ThisCopy;
  owner: AssociationOwner;
  installerChoices: string | null;
  failure: Error | null;
  readonly actions: string[];
}

let folder = '';
let storePath = '';
let checks: boolean[] = [];
let checkResult: BridgeResult<null> = { ok: true, value: null };

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-setup-'));
  storePath = join(folder, 'setup.json');
  checks = [];
  checkResult = { ok: true, value: null };
  ipcMain.handlers.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

/** Builds a copy of Tasklace whose registry and files are fakes that record what they are asked. */
function fakeCopy(kind: CopyKind, owner: AssociationOwner = { kind: 'none' }): FakeCopy {
  const fake: FakeCopy = {
    owner,
    installerChoices: null,
    failure: null,
    actions: [],
    copy: {
      kind,
      executable: EXECUTABLE,
      registry: {} as Registry,
      associations: {} as FileAssociations,
    },
  };
  /** Fails with the failure set for the test, if any. */
  const failing = (): void => {
    if (fake.failure !== null) {
      throw fake.failure;
    }
  };
  const registry: Registry = {
    exportKey: (key) => {
      failing();
      fake.actions.push(`export ${key}`);
      return Promise.resolve(key === INSTALLER_CHOICES_KEY ? fake.installerChoices : null);
    },
    importText: () => Promise.reject(new Error('The setup never imports registry files itself.')),
    deleteKey: (key) => {
      fake.actions.push(`delete ${key}`);
      return Promise.resolve();
    },
  };
  const associations: FileAssociations = {
    owner: () => {
      failing();
      return Promise.resolve(fake.owner);
    },
    register: () => {
      failing();
      fake.actions.push('register');
      fake.owner = { kind: 'thisCopy' };
      return Promise.resolve();
    },
    unregister: () => {
      failing();
      fake.actions.push('unregister');
      fake.owner = { kind: 'none' };
      return Promise.resolve();
    },
  };
  return Object.assign(fake, { copy: { ...fake.copy, registry, associations } });
}

/** Registers the channels of the setup for a copy. */
function register(copy: ThisCopy | null): Setup {
  return registerSetupHandlers({
    assertTrusted: () => undefined,
    storePath,
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

/** Reads what the store of the setup holds. */
async function stored(): Promise<unknown> {
  return JSON.parse(await readFile(storePath, 'utf8'));
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

describe('readWelcomeChoices', () => {
  it('reads exactly the two choices of the welcome window', () => {
    expect(readWelcomeChoices({ associate: true, checkForNewVersions: false })).toEqual({
      associate: true,
      checkForNewVersions: false,
    });
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

describe('a copy that opens no files', () => {
  it('shows no welcome, has nothing to register and refuses to change anything', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const setup = register(null);
    expect(await ask(IPC_CHANNELS.setupState)).toEqual({
      ok: true,
      value: { welcome: false, association: { kind: 'unavailable' } },
    });
    expect(setup.welcomePending()).toBe(false);
    const refused = { ok: false, error: { code: 'TASK_FAILED' } };
    const choices = { associate: true, checkForNewVersions: true };
    expect(await ask(IPC_CHANNELS.finishWelcome, choices)).toEqual(refused);
    expect(await ask(IPC_CHANNELS.setFileAssociation, true)).toEqual(refused);
    expect(error.mock.calls).toEqual([
      ['The page asked to finish a welcome that was not shown, or with other choices:', choices],
      ['The page asked to change which copy opens project files with:', true],
    ]);
    expect(checks).toEqual([]);
  });
});

describe('the portable version', () => {
  it('asks its choices once at its first launch, holding back the check until then, and applies them', async () => {
    const fake = fakeCopy('portable');
    const setup = register(fake.copy);
    expect(await ask(IPC_CHANNELS.setupState)).toEqual({
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    });
    expect(setup.welcomePending()).toBe(true);
    expect(
      await ask(IPC_CHANNELS.finishWelcome, { associate: true, checkForNewVersions: false }),
    ).toEqual({ ok: true, value: { kind: 'thisCopy' } });
    expect([setup.welcomePending(), checks, fake.actions]).toEqual([false, [false], ['register']]);
    expect(await stored()).toEqual({
      version: 1,
      settings: { welcomed: true, registeredExecutable: EXECUTABLE },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await ask(IPC_CHANNELS.finishWelcome, { associate: true, checkForNewVersions: true }),
    ).toEqual({ ok: false, error: { code: 'TASK_FAILED' } });
    ipcMain.handlers.clear();
    register(fake.copy);
    expect(await ask(IPC_CHANNELS.setupState)).toEqual({
      ok: true,
      value: { welcome: false, association: { kind: 'thisCopy' } },
    });
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
    expect(setup.welcomePending()).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('closes the welcome but reports choices that could not be applied', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeCopy('portable');
    const setup = register(fake.copy);
    await ask(IPC_CHANNELS.setupState);
    checkResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    const choices = { associate: true, checkForNewVersions: true };
    expect(await ask(IPC_CHANNELS.finishWelcome, choices)).toEqual(checkResult);
    expect([setup.welcomePending(), fake.actions]).toEqual([false, []]);
    ipcMain.handlers.clear();
    register(fake.copy);
    checkResult = { ok: true, value: null };
    fake.failure = TOOL_FAILURE;
    await writeFile(storePath, '');
    const failed = register(fake.copy);
    expect(failed.welcomePending()).toBe(false);
    expect(await ask(IPC_CHANNELS.finishWelcome, choices)).toEqual({
      ok: false,
      error: { code: 'WRITE_FAILED' },
    });
    expect(error.mock.calls).toEqual([
      ['The choices of the welcome window could not be applied:', TOOL_FAILURE],
    ]);
  });

  it('keeps opening files when it moved, never taking them from another copy', async () => {
    const moved = fakeCopy('portable', { kind: 'otherCopy', path: FORMER.toUpperCase() });
    await storeSetup(true, FORMER);
    register(moved.copy);
    expect(await ask(IPC_CHANNELS.setupState)).toEqual({
      ok: true,
      value: { welcome: false, association: { kind: 'thisCopy' } },
    });
    expect(moved.actions).toEqual(['register']);
    expect(await stored()).toEqual({
      version: 1,
      settings: { welcomed: true, registeredExecutable: EXECUTABLE },
    });
    for (const owner of [{ kind: 'otherCopy', path: ELSEWHERE }, { kind: 'none' }] as const) {
      ipcMain.handlers.clear();
      await storeSetup(true, FORMER);
      const other = fakeCopy('portable', owner);
      register(other.copy);
      expect(await ask(IPC_CHANNELS.setupState)).toEqual({
        ok: true,
        value: { welcome: false, association: owner },
      });
      expect(other.actions).toEqual([]);
    }
  });

  it('asks again when its setup cannot be prepared, so that nothing is sent before the person chose', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeCopy('portable');
    await storeSetup(true, FORMER);
    fake.failure = TOOL_FAILURE;
    const setup = register(fake.copy);
    expect(await ask(IPC_CHANNELS.setupState)).toEqual({
      ok: false,
      error: { code: 'READ_FAILED' },
    });
    expect(setup.welcomePending()).toBe(true);
    expect(error.mock.calls).toEqual([
      ['The setup of Tasklace could not be prepared:', TOOL_FAILURE],
      ['Tasklace could not find out which copy opens project files:', TOOL_FAILURE],
    ]);
  });
});

describe('the installed version', () => {
  it('applies once the choices its installer left, then removes them', async () => {
    const fake = fakeCopy('installed');
    fake.installerChoices = installerChoices(1, 0);
    const setup = register(fake.copy);
    expect(await ask(IPC_CHANNELS.setupState)).toEqual({
      ok: true,
      value: { welcome: false, association: { kind: 'thisCopy' } },
    });
    expect([setup.welcomePending(), checks, fake.actions]).toEqual([
      false,
      [false],
      [`export ${INSTALLER_CHOICES_KEY}`, 'register', `delete ${INSTALLER_CHOICES_KEY}`],
    ]);
    expect(await stored()).toEqual({
      version: 1,
      settings: { welcomed: true, registeredExecutable: EXECUTABLE },
    });
  });

  it('leaves the files to the installer once registered, and to any copy when the person chose so', async () => {
    const registered = fakeCopy('installed', { kind: 'thisCopy' });
    registered.installerChoices = installerChoices(1, 1);
    register(registered.copy);
    await ask(IPC_CHANNELS.setupState);
    expect([checks, registered.actions]).toEqual([
      [true],
      [`export ${INSTALLER_CHOICES_KEY}`, `delete ${INSTALLER_CHOICES_KEY}`],
    ]);
    ipcMain.handlers.clear();
    const declined = fakeCopy('installed');
    declined.installerChoices = installerChoices(0, 0);
    register(declined.copy);
    await ask(IPC_CHANNELS.setupState);
    expect(declined.actions).toEqual([
      `export ${INSTALLER_CHOICES_KEY}`,
      `delete ${INSTALLER_CHOICES_KEY}`,
    ]);
    expect(await stored()).toEqual({
      version: 1,
      settings: { welcomed: true, registeredExecutable: null },
    });
  });

  it('logs an installer choice about new versions it could not keep, applying the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    checkResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    const fake = fakeCopy('installed');
    fake.installerChoices = installerChoices(1, 1);
    register(fake.copy);
    await ask(IPC_CHANNELS.setupState);
    expect(fake.actions).toEqual([
      `export ${INSTALLER_CHOICES_KEY}`,
      'register',
      `delete ${INSTALLER_CHOICES_KEY}`,
    ]);
    expect(error.mock.calls).toEqual([
      ['The choice of the installer about new versions could not be kept.'],
    ]);
  });

  it('shows no welcome without choices from the installer, and follows a move like the portable version', async () => {
    const fake = fakeCopy('installed', { kind: 'otherCopy', path: FORMER });
    await storeSetup(true, FORMER);
    const setup = register(fake.copy);
    await ask(IPC_CHANNELS.setupState);
    expect([setup.welcomePending(), checks, fake.actions]).toEqual([
      false,
      [],
      [`export ${INSTALLER_CHOICES_KEY}`, 'register'],
    ]);
  });

  it('shows no welcome when its setup cannot be prepared, its installer having asked', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeCopy('installed');
    fake.failure = TOOL_FAILURE;
    expect(register(fake.copy).welcomePending()).toBe(false);
    await ask(IPC_CHANNELS.setupState);
    expect(error.mock.calls[0]).toEqual([
      'The setup of Tasklace could not be prepared:',
      TOOL_FAILURE,
    ]);
  });

  it('lets an error of the program through rather than taking it for a failure of the system', async () => {
    const fake = fakeCopy('installed');
    fake.failure = new TypeError('a fault of the program');
    register(fake.copy);
    await expect(ask(IPC_CHANNELS.setupState)).rejects.toThrow('a fault of the program');
  });
});

describe('the switch of the settings', () => {
  it('makes this copy open files and links, and stops it only when it opens them', async () => {
    const fake = fakeCopy('installed', { kind: 'otherCopy', path: ELSEWHERE });
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
    register(fake.copy);
    expect(await ask(IPC_CHANNELS.setFileAssociation, 'on')).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    await ask(IPC_CHANNELS.setupState);
    fake.failure = TOOL_FAILURE;
    expect(await ask(IPC_CHANNELS.setFileAssociation, true)).toEqual({
      ok: false,
      error: { code: 'WRITE_FAILED' },
    });
    expect(error.mock.calls).toEqual([
      ['The page asked to change which copy opens project files with:', 'on'],
      ['The copy that opens project files could not be changed:', TOOL_FAILURE],
    ]);
  });

  it('lets an error of the program through rather than reporting it as a refused change', async () => {
    const fake = fakeCopy('installed');
    register(fake.copy);
    await ask(IPC_CHANNELS.setupState);
    fake.failure = new TypeError('a fault of the program');
    await expect(ask(IPC_CHANNELS.setFileAssociation, true)).rejects.toThrow(
      'a fault of the program',
    );
  });
});
