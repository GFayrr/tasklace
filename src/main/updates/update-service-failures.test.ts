import { ipcMain as electronIpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../preload/bridge-contract';
import type { FakeIpcMain } from '../testing/fake-electron';
import { registerUpdateHandlers } from './update-service';

const broken = vi.hoisted(() => ({
  read: null as Error | null,
  write: null as Error | null,
}));

vi.mock('electron', async () => {
  const fakes = await import('../testing/fake-electron');
  return { ipcMain: new fakes.FakeIpcMain() };
});

vi.mock('../stored-files', async (importOriginal) => {
  const original = await importOriginal<typeof import('../stored-files')>();
  return {
    ...original,
    readStoredText: () =>
      broken.read === null ? Promise.resolve('') : Promise.reject(broken.read),
  };
});

vi.mock('../safe-write', () => ({
  writeFileSafely: () => (broken.write === null ? Promise.resolve() : Promise.reject(broken.write)),
}));

const ipcMain = electronIpcMain as unknown as FakeIpcMain;
const NEWER = JSON.stringify([{ tag_name: 'v0.2.0', draft: false, prerelease: true }]);

/** Makes an error of the system with a code, as Node gives one. */
function systemError(code: string): Error {
  return Object.assign(new Error(`${code}: refused`), { code });
}

beforeEach(() => {
  broken.read = null;
  broken.write = null;
  ipcMain.handlers.clear();
  registerUpdateHandlers({
    assertTrusted: () => undefined,
    storePath: '/store/update-check.json',
    version: '0.1.0',
    isPackaged: true,
    now: () => new Date(2026, 9, 30),
    fetchReleases: () => Promise.resolve(new Response(NEWER)),
    openInBrowser: () => Promise.resolve(true),
    welcomePending: () => false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Asks a channel as the page would. */
async function ask(channel: string, ...values: unknown[]): Promise<unknown> {
  return await Promise.resolve(ipcMain.invoke(channel, { sender: {} }, ...values));
}

describe('the channels of new versions when the store fails', () => {
  it('reports a store the system cannot read, logging why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    broken.read = systemError('EACCES');
    const unreadable = { ok: false, error: { code: 'READ_FAILED' } };
    expect(await ask(IPC_CHANNELS.updateSettings)).toEqual(unreadable);
    expect(await ask(IPC_CHANNELS.checkAtLaunch)).toEqual(unreadable);
    expect(await ask(IPC_CHANNELS.setCheckForNewVersions, true)).toEqual(unreadable);
    expect(error.mock.calls).toEqual([
      ['The settings of new versions could not be read:', broken.read],
      ['The settings of new versions could not be read:', broken.read],
      ['The settings of new versions could not be read:', broken.read],
    ]);
  });

  it('reports a setting the system cannot write, logging why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    broken.write = systemError('EROFS');
    expect(await ask(IPC_CHANNELS.setCheckForNewVersions, false)).toEqual({
      ok: false,
      error: { code: 'WRITE_FAILED' },
    });
    expect(error.mock.calls).toEqual([
      ['The settings of new versions could not be written:', broken.write],
    ]);
  });

  it('still gives the result of a check whose day cannot be kept, logging why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    broken.write = systemError('EROFS');
    expect(await ask(IPC_CHANNELS.checkNow)).toEqual({
      ok: true,
      value: { kind: 'newer', version: '0.2.0' },
    });
    expect(error.mock.calls).toEqual([
      ['The day of the check for new versions could not be kept:', broken.write],
    ]);
  });

  it('lets through a failure that does not come from the system', async () => {
    broken.read = new TypeError('a fault of the program');
    await expect(ask(IPC_CHANNELS.updateSettings)).rejects.toBe(broken.read);
    broken.read = null;
    broken.write = new TypeError('another fault');
    await expect(ask(IPC_CHANNELS.setCheckForNewVersions, false)).rejects.toBe(broken.write);
    await expect(ask(IPC_CHANNELS.checkNow)).rejects.toBe(broken.write);
  });
});
