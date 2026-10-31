import { ipcMain as electronIpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawRelayAccess } from '../core/collaboration/relay/relay-keys';
import { encodeRelayLink } from '../core/collaboration/relay/relay-link';
import { MAX_FILE_PATH_LENGTH } from '../core/limits';
import { seededRandom } from '../core/testing/test-crypto';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import { readOutsideRequest, registerOutsideRequests } from './outside-request';
import type { FakeIpcMain } from './testing/fake-electron';

vi.mock('electron', async () => {
  const fakes = await import('./testing/fake-electron');
  return { ipcMain: new fakes.FakeIpcMain() };
});

const ipcMain = electronIpcMain as unknown as FakeIpcMain;
const EXECUTABLE = '/opt/Tasklace/tasklace';
const PROJECT = '/home/lea/Plans/Thesis.tasklace';
const LINK = encodeRelayLink({
  address: { host: 'relay.school.example', port: null, path: '/' },
  access: drawRelayAccess(seededRandom(9)),
});

beforeEach(() => {
  ipcMain.handlers.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Asks a channel as the page would. */
async function ask(channel: string): Promise<unknown> {
  return await Promise.resolve(ipcMain.invoke(channel, { sender: {} }));
}

describe('readOutsideRequest', () => {
  it('reads a project file or a link as the last argument, after the separator Windows writes', () => {
    expect(readOutsideRequest([EXECUTABLE, '--', PROJECT])).toEqual({
      kind: 'file',
      path: PROJECT,
    });
    expect(readOutsideRequest([EXECUTABLE, '--', '/home/lea/Old.TASKLACE'])).toEqual({
      kind: 'file',
      path: '/home/lea/Old.TASKLACE',
    });
    expect(readOutsideRequest([EXECUTABLE, '--allow-file-access', '--', LINK])).toEqual({
      kind: 'link',
      link: LINK,
    });
    expect(readOutsideRequest([EXECUTABLE, '--', `${LINK}\n`])).toEqual({
      kind: 'link',
      link: LINK,
    });
  });

  it('ignores a launch without anything, or with anything but a project file or a link, such as the script of the application or an option', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const argv of [
      [],
      [EXECUTABLE],
      [EXECUTABLE, '/opt/Tasklace/out/main/index.js'],
      [EXECUTABLE, '--', '--gpu-launcher=calc.exe'],
      [EXECUTABLE, '--', '/home/lea/Plans/Thesis.csv'],
      [EXECUTABLE, '--', '/home/lea/Plans/Thesis.tasklace.exe'],
    ]) {
      expect(readOutsideRequest(argv), JSON.stringify(argv)).toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a link it cannot read and a project path it cannot use without writing them, a link holding the keys of a plan', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const value of [
      'tasklace://relay.school.example/#e1.short',
      `TASKLACE://x --gpu-launcher="calc.exe"`,
      'Plans/Thesis.tasklace',
      `/${'a'.repeat(MAX_FILE_PATH_LENGTH)}.tasklace`,
      '/home/lea/\0.tasklace',
    ]) {
      expect(readOutsideRequest([EXECUTABLE, '--', value]), value).toBeNull();
    }
    expect(warn.mock.calls).toEqual([
      ['Tasklace was started with a link it cannot read.'],
      ['Tasklace was started with a link it cannot read.'],
      ['Tasklace was started with a project file whose path it cannot use.'],
      ['Tasklace was started with a project file whose path it cannot use.'],
      ['Tasklace was started with a project file whose path it cannot use.'],
    ]);
  });
});

describe('registerOutsideRequests', () => {
  it('keeps the latest request until the page takes it, the path of a file staying in the main process until it opens', async () => {
    let told = 0;
    const requests = registerOutsideRequests({
      assertTrusted: () => undefined,
      notify: () => {
        told += 1;
      },
    });
    expect(await ask(IPC_CHANNELS.takeOutsideRequest)).toEqual({ ok: true, value: null });
    requests.receive([EXECUTABLE]);
    expect(told).toBe(0);
    requests.receive([EXECUTABLE, '--', LINK]);
    requests.receive([EXECUTABLE, '--', PROJECT]);
    expect(told).toBe(2);
    expect(requests.takeFile()).toBeNull();
    expect(await ask(IPC_CHANNELS.takeOutsideRequest)).toEqual({
      ok: true,
      value: { kind: 'file' },
    });
    expect(await ask(IPC_CHANNELS.takeOutsideRequest)).toEqual({ ok: true, value: null });
    expect(requests.takeFile()).toBe(PROJECT);
    expect(requests.takeFile()).toBeNull();
    requests.receive([EXECUTABLE, '--', LINK]);
    expect(await ask(IPC_CHANNELS.takeOutsideRequest)).toEqual({
      ok: true,
      value: { kind: 'link', link: LINK },
    });
    expect(requests.takeFile()).toBeNull();
  });

  it('answers only a trusted page', async () => {
    registerOutsideRequests({
      assertTrusted: () => {
        throw new Error('Untrusted page');
      },
      notify: () => undefined,
    });
    await expect(ask(IPC_CHANNELS.takeOutsideRequest)).rejects.toThrow('Untrusted page');
  });
});
