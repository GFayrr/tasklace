import { ipcMain as electronIpcMain } from 'electron';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawRelayAccess } from '../core/collaboration/relay/relay-keys';
import { encodeRelayLink } from '../core/collaboration/relay/relay-link';
import { MAX_FILE_PATH_LENGTH, MAX_WAITING_OUTSIDE_FILES } from '../core/limits';
import { seededRandom } from '../core/testing/test-crypto';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import { createOutsideRequests, readOutsideRequest } from './outside-request';
import type { FakeIpcMain } from './testing/fake-electron';

const address = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock('node:url', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:url')>();
  return {
    ...real,
    fileURLToPath: (url: URL) => {
      if (address.failure !== null) {
        throw address.failure;
      }
      return real.fileURLToPath(url);
    },
  };
});

vi.mock('electron', async () => {
  const fakes = await import('./testing/fake-electron');
  return { ipcMain: new fakes.FakeIpcMain() };
});

const ipcMain = electronIpcMain as unknown as FakeIpcMain;
const EXECUTABLE = '/opt/Tasklace/tasklace';
const PROJECT = '/home/lea/Plans/Thesis.tasklace';
const SPACED_PROJECT = resolve('/home/léa/Mes plans/Thèse 2.tasklace');
const LINK = encodeRelayLink({
  address: { host: 'relay.school.example', port: null, path: '/' },
  access: drawRelayAccess(seededRandom(9)),
});

beforeEach(() => {
  ipcMain.handlers.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  address.failure = null;
});

/** Writes a path of this computer as the address the Linux desktop passes for a file. */
function fileAddress(path: string): string {
  return pathToFileURL(path).href;
}

/** Asks a channel as the page would. */
async function ask(channel: string): Promise<unknown> {
  return await Promise.resolve(ipcMain.invoke(channel, { sender: {} }));
}

describe('readOutsideRequest', () => {
  it('reads a project file or a link as the last argument, after the separator Windows writes', () => {
    expect(readOutsideRequest([EXECUTABLE, '--', PROJECT])).toEqual({
      kind: 'file',
      path: PROJECT,
      unopened: 0,
    });
    expect(readOutsideRequest([EXECUTABLE, '--', '/home/lea/Old.TASKLACE'])).toEqual({
      kind: 'file',
      path: '/home/lea/Old.TASKLACE',
      unopened: 0,
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
      unopened: 0,
    });
  });

  it('reads a project file given as an address of this computer, as the Linux desktop passes it', () => {
    const written = fileAddress(SPACED_PROJECT);
    for (const value of [
      written,
      written.replace('file:', 'FILE:'),
      written.replace('file:///', 'file://localhost/'),
    ]) {
      expect(readOutsideRequest([EXECUTABLE, '--', value]), value).toEqual({
        kind: 'file',
        path: SPACED_PROJECT,
        unopened: 0,
      });
    }
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
      [EXECUTABLE, '--', fileAddress(resolve('/home/lea/Plans/Thesis.csv'))],
      [EXECUTABLE, '--', `${fileAddress(resolve('/home/lea/Thesis.tasklace'))}.exe`],
    ]) {
      expect(readOutsideRequest(argv), JSON.stringify(argv)).toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a file address that names another computer or hides a path, without its text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refused = [
      'file://server.school.example/Plans/Thesis.tasklace',
      'file://[malformed/Thesis.tasklace',
      'file:///home/lea/..%2F..%2Fetc%2FThesis.tasklace',
      'file:///home/lea/%00.tasklace',
      'file:///home/l%E9a/Thesis.tasklace',
      'file:///home/lea/%FF.tasklace',
      'file:///home/lea/a%ZZ.tasklace',
      'file:Thesis.tasklace',
      'file:../Thesis.tasklace',
      'file:/home/lea/Thesis.tasklace',
    ];
    for (const value of refused) {
      expect(readOutsideRequest([EXECUTABLE, '--', value]), value).toEqual({
        kind: 'unreadable',
        what: 'file',
      });
    }
    expect(warn.mock.calls).toEqual(
      refused.map(() => ['Tasklace was started with a project file whose path it cannot use.']),
    );
  });

  it('opens the last of the files passed at once, as the Linux desktop passes them, counting the others in the log without their text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      readOutsideRequest([
        EXECUTABLE,
        '--',
        '/home/lea/One.tasklace',
        '/home/lea/Two.csv',
        PROJECT,
      ]),
    ).toEqual({ kind: 'file', path: PROJECT, unopened: 2 });
    expect(warn.mock.calls).toEqual([
      ['Tasklace was started with 3 files and opens the last one.'],
    ]);
  });

  it('counts nothing alongside a file passed without the separator', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readOutsideRequest([EXECUTABLE, '/home/lea/One.tasklace', PROJECT])).toEqual({
      kind: 'file',
      path: PROJECT,
      unopened: 0,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets a fault of the program through, which is no bad address', () => {
    const fault = new RangeError('a fault of the program');
    address.failure = fault;
    expect(() => readOutsideRequest([EXECUTABLE, '--', fileAddress(SPACED_PROJECT)])).toThrow(
      fault,
    );
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
      value: { kind: 'file', id: 1, unopened: 0 },
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
      value: { kind: 'file', id: 2, unopened: 0 },
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
