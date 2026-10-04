import { ipcMain as electronIpcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import { registerIpcHandlers } from './ipc-handlers';
import type { FakeIpcMain } from './testing/fake-electron';

const openExternal = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('electron', async () => {
  const fakes = await import('./testing/fake-electron');
  return {
    app: { getVersion: () => '1.2.3' },
    ipcMain: new fakes.FakeIpcMain(),
    shell: { openExternal },
  };
});

const ipcMain = electronIpcMain as unknown as FakeIpcMain;
const trusted = vi.fn();
registerIpcHandlers(trusted);
const EVENT = { senderFrame: { url: 'app://tasklace/index.html' } };

beforeEach(() => {
  trusted.mockReset();
  openExternal.mockClear();
});

describe('registerIpcHandlers', () => {
  it('gives the version of the application to a page of the application', () => {
    expect(ipcMain.invoke(IPC_CHANNELS.appVersion, EVENT)).toBe('1.2.3');
    expect(trusted).toHaveBeenCalledWith(EVENT);
  });

  it('opens only allowed addresses in the browser', async () => {
    expect(
      await ipcMain.invoke(IPC_CHANNELS.openExternal, EVENT, 'https://github.com/GFayrr/tasklace'),
    ).toBe(true);
    expect(await ipcMain.invoke(IPC_CHANNELS.openExternal, EVENT, 'https://example.com/')).toBe(
      false,
    );
    expect(await ipcMain.invoke(IPC_CHANNELS.openExternal, EVENT, 42)).toBe(false);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('answers nothing to a page that is not the application', () => {
    trusted.mockImplementation(() => {
      throw new Error('Request refused');
    });
    expect(() => ipcMain.invoke(IPC_CHANNELS.appVersion, EVENT)).toThrow('Request refused');
    expect(() =>
      ipcMain.invoke(IPC_CHANNELS.openExternal, EVENT, 'https://github.com/GFayrr/tasklace'),
    ).toThrow('Request refused');
    expect(openExternal).not.toHaveBeenCalled();
  });
});
