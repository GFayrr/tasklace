import { ipcMain as electronIpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawRelayAccess } from '../core/collaboration/relay/relay-keys';
import { encodeRelayLink } from '../core/collaboration/relay/relay-link';
import { MAX_FILE_PATH_LENGTH, MAX_WAITING_OUTSIDE_FILES } from '../core/limits';
import { seededRandom } from '../core/testing/test-crypto';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import { createOutsideRequests, readOutsideRequest } from './outside-request';
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
    expect(readOutsideRequest([EXECUTABLE, '--', '/home/léa/Mes plans/Thèse 2.tasklace'])).toEqual({
      kind: 'file',
      path: '/home/léa/Mes plans/Thèse 2.tasklace',
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
      [EXECUTABLE, '--', '--updated'],
    ]) {
      expect(readOutsideRequest(argv), JSON.stringify(argv)).toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('tells of a link it cannot read and a project path it cannot use, logging them without their text, a link holding the keys of a plan', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unreadable = [
      ['tasklace://relay.school.example/#e1.short', 'link'],
      [`TASKLACE://x --gpu-launcher="calc.exe"`, 'link'],
      ['Plans/Thesis.tasklace', 'file'],
      [`/${'a'.repeat(MAX_FILE_PATH_LENGTH)}.tasklace`, 'file'],
      ['/home/lea/\0.tasklace', 'file'],
    ] as const;
    for (const [value, what] of unreadable) {
      expect(readOutsideRequest([EXECUTABLE, '--', value]), value).toEqual({
        kind: 'unreadable',
        what,
      });
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

describe('createOutsideRequests', () => {
  it('keeps the latest request from the first launch on until the page takes it, telling the page once it can answer', async () => {
    let told = 0;
    const requests = createOutsideRequests();
    requests.receive([EXECUTABLE, '--', PROJECT]);
    requests.receive([EXECUTABLE]);
    requests.answer(
      () => undefined,
      () => {
        told += 1;
      },
    );
    expect(told).toBe(0);
    expect(await ask(IPC_CHANNELS.takeOutsideRequest)).toEqual({
      ok: true,
      value: { kind: 'file', id: 1 },
    });
    expect(await ask(IPC_CHANNELS.takeOutsideRequest)).toEqual({ ok: true, value: null });
    requests.receive([EXECUTABLE, '--', LINK]);
    requests.receive([EXECUTABLE, '--', 'tasklace://cut']);
    expect(told).toBe(2);
    expect(await ask(IPC_CHANNELS.takeOutsideRequest)).toEqual({
      ok: true,
      value: { kind: 'unreadable', what: 'link' },
    });
    requests.receive([EXECUTABLE, '--', LINK]);
    expect(await ask(IPC_CHANNELS.takeOutsideRequest)).toEqual({
      ok: true,
      value: { kind: 'link', link: LINK },
    });
  });

  it("keeps the path of each file taken under its own number until it opens, so that two files never take each other's place", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const requests = createOutsideRequests();
    requests.answer(
      () => undefined,
      () => undefined,
    );
    requests.receive([EXECUTABLE, '--', PROJECT]);
    await ask(IPC_CHANNELS.takeOutsideRequest);
    requests.receive([EXECUTABLE, '--', '/home/lea/Other.tasklace']);
    expect(await ask(IPC_CHANNELS.takeOutsideRequest)).toEqual({
      ok: true,
      value: { kind: 'file', id: 2 },
    });
    expect(requests.takeFile(2)).toBe('/home/lea/Other.tasklace');
    expect(requests.takeFile(1)).toBe(PROJECT);
    expect([requests.takeFile(1), requests.takeFile(3)]).toEqual([null, null]);
  });

  it('forgets the oldest files nobody opened beyond the number it keeps', async () => {
    const requests = createOutsideRequests();
    requests.answer(
      () => undefined,
      () => undefined,
    );
    for (let index = 1; index <= MAX_WAITING_OUTSIDE_FILES + 1; index += 1) {
      requests.receive([EXECUTABLE, '--', `/home/lea/Plan ${String(index)}.tasklace`]);
      await ask(IPC_CHANNELS.takeOutsideRequest);
    }
    expect(requests.takeFile(1)).toBeNull();
    expect(requests.takeFile(2)).toBe('/home/lea/Plan 2.tasklace');
    expect(requests.takeFile(MAX_WAITING_OUTSIDE_FILES + 1)).toBe(
      `/home/lea/Plan ${String(MAX_WAITING_OUTSIDE_FILES + 1)}.tasklace`,
    );
  });

  it('answers only a trusted page', async () => {
    createOutsideRequests().answer(
      () => {
        throw new Error('Untrusted page');
      },
      () => undefined,
    );
    await expect(ask(IPC_CHANNELS.takeOutsideRequest)).rejects.toThrow('Untrusted page');
  });
});
