import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain as electronIpcMain, type WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { success } from '../../core/result';
import { TEST_DOCUMENT_ID } from '../../core/testing/project-builder';
import { IPC_CHANNELS, type CollaborationEvent } from '../../preload/bridge-contract';
import type { FileTask } from '../file-tasks';
import type { FakeIpcMain } from '../testing/fake-electron';
import {
  privateAddressesOf,
  registerCollaborationHandlers,
  startGuest,
  type WindowSharing,
} from './collaboration-service';
import type { AnnouncedService, Mdns } from './discovery';

vi.mock('electron', async () => {
  const fakes = await import('../testing/fake-electron');
  return { ipcMain: new fakes.FakeIpcMain() };
});

vi.mock('../project-files', () => ({
  offerSharedProject: (_sender: unknown, loaded: { state: Uint8Array; documentId: string }) => ({
    state: loaded.state,
    documentId: loaded.documentId,
    fileName: '',
    warnings: [],
  }),
}));

const ipcMain = electronIpcMain as unknown as FakeIpcMain;
const LOOPBACK = '127.0.0.1';

/** A fake page that records the events the main process sends it. */
class FakePage {
  readonly events: CollaborationEvent[] = [];
  destroyed = false;

  /** Records an event sent on the channel of the shared plan. */
  send(channel: string, event: CollaborationEvent): void {
    if (channel === IPC_CHANNELS.collaborationEvent) {
      this.events.push(event);
    }
  }

  /** Tells whether the page is gone. */
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

/** Builds a fake mDNS recording what is published and letting the test announce services. */
function fakeMdns() {
  const published: unknown[] = [];
  const listeners = new Map<string, (service: AnnouncedService) => void>();
  const record = { published, listeners, destroyed: 0, browsersStopped: 0, servicesStopped: 0 };
  const mdns: Mdns = {
    publish: (options) => {
      published.push(options);
      return {
        stop: (done) => {
          record.servicesStopped += 1;
          done?.();
        },
      };
    },
    find: () => ({
      on: (event, listener) => listeners.set(event, listener),
      stop: () => {
        record.browsersStopped += 1;
      },
    }),
  };
  return { record, mdns };
}

/** Finds a port nobody listens on. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address();
      probe.close(() => {
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  });
}

/** Waits until a condition holds. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let folder = '';
let mdnsFake = fakeMdns();
let tasks: FileTask[] = [];
let copied: string[] = [];
let uncopyable = '';
let forget: (sender: never) => void = () => undefined;
const trusted = vi.fn();

/** Invokes a channel as a page would, a refusal coming back as a rejection as Electron gives it. */
async function invoke(page: FakePage, channel: string, ...values: unknown[]): Promise<unknown> {
  return await Promise.resolve(ipcMain.invoke(channel, { sender: page }, ...values));
}

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-service-'));
  mdnsFake = fakeMdns();
  tasks = [];
  copied = [];
  uncopyable = '';
  trusted.mockClear();
  const registered = registerCollaborationHandlers({
    assertTrusted: trusted,
    userDataFolder: folder,
    runTask: (task) => {
      tasks.push(task);
      return Promise.resolve(
        success({
          kind: 'loaded',
          state: Uint8Array.of(1),
          documentId: TEST_DOCUMENT_ID,
          warnings: [],
        }),
      ) as never;
    },
    createMdns: () => ({
      mdns: mdnsFake.mdns,
      destroy: () => {
        mdnsFake.record.destroyed += 1;
      },
    }),
    addresses: () => ['192.168.1.24'],
    copyText: (text) => {
      if (text === uncopyable) {
        return Promise.reject(new Error('Clipboard unavailable'));
      }
      copied.push(text);
      return Promise.resolve();
    },
  });
  forget = registered.forgetWindow;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

/** Shares a plan from a page on a free port, giving what the page was told. */
async function shareFrom(page: FakePage) {
  const port = await freePort();
  await invoke(page, IPC_CHANNELS.saveCollaborationSettings, {
    name: 'Camille',
    port,
    firewallNoticeSeen: false,
  });
  return invoke(page, IPC_CHANNELS.sharePlan, 'Thesis', 'Camille');
}

describe('the collaboration service', () => {
  it('reads and keeps the settings, refusing settings of another shape', async () => {
    const page = new FakePage();
    expect(await invoke(page, IPC_CHANNELS.collaborationSettings)).toEqual(
      success({ name: null, port: 47_313, firewallNoticeSeen: false }),
    );
    const settings = { name: 'Léa', port: 50_000, firewallNoticeSeen: true };
    expect(await invoke(page, IPC_CHANNELS.saveCollaborationSettings, settings)).toEqual(
      success(null),
    );
    expect(await invoke(page, IPC_CHANNELS.collaborationSettings)).toEqual(success(settings));
    await expect(invoke(page, IPC_CHANNELS.saveCollaborationSettings, { name: 1 })).rejects.toThrow(
      'Request refused: its content is not valid.',
    );
    expect(trusted).toHaveBeenCalledTimes(4);
  });

  it('reports settings the system cannot read or write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await mkdir(join(folder, 'collaboration-settings.json'));
    const page = new FakePage();
    expect(await invoke(page, IPC_CHANNELS.collaborationSettings)).toEqual({
      ok: false,
      error: { code: 'READ_FAILED' },
    });
    expect(
      await invoke(page, IPC_CHANNELS.saveCollaborationSettings, {
        name: null,
        port: 1,
        firewallNoticeSeen: false,
      }),
    ).toEqual({ ok: false, error: { code: 'WRITE_FAILED' } });
    expect(await invoke(page, IPC_CHANNELS.sharePlan, 'Thesis', 'Camille')).toEqual({
      ok: false,
      error: { code: 'READ_FAILED' },
    });
  });

  it('shares a plan, lets a guest join and passes their messages both ways, until the host drops the guest', async () => {
    const host = new FakePage();
    const guest = new FakePage();
    const shared = (await shareFrom(host)) as {
      ok: true;
      value: { code: string; port: number; addresses: string[] };
    };
    expect([shared.ok, shared.value.code.length, shared.value.addresses]).toEqual([
      true,
      6,
      ['192.168.1.24'],
    ]);
    expect(mdnsFake.record.published).toEqual([
      {
        name: expect.stringMatching(/^Tasklace [0-9a-f]{8}$/) as unknown,
        type: 'tasklace',
        port: shared.value.port,
        txt: { v: '1', plan: 'Thesis', host: 'Camille' },
      },
    ]);
    expect(await invoke(host, IPC_CHANNELS.sharePlan, 'Thesis', 'Camille')).toEqual({
      ok: false,
      error: { code: 'ALREADY_SHARING' },
    });
    const request = {
      address: LOOPBACK,
      port: shared.value.port,
      code: shared.value.code,
      participantId: 'lea',
      name: 'Léa',
    };
    expect(await invoke(guest, IPC_CHANNELS.joinPlan, request)).toEqual(success(null));
    expect(await invoke(guest, IPC_CHANNELS.joinPlan, request)).toEqual({
      ok: false,
      error: { code: 'ALREADY_SHARING' },
    });
    await until(() => host.events.length === 1 && guest.events.length === 1);
    expect([host.events, guest.events]).toEqual([
      [{ kind: 'peerJoined', peer: 1, participantId: 'lea', name: 'Léa' }],
      [{ kind: 'connected' }],
    ]);
    ipcMain.send(IPC_CHANNELS.collaborationSend, { sender: host }, 1, Uint8Array.of(1));
    ipcMain.send(IPC_CHANNELS.collaborationSend, { sender: guest }, 'host', Uint8Array.of(2));
    await until(() => host.events.length === 2 && guest.events.length === 2);
    expect([host.events[1], guest.events[1]]).toEqual([
      { kind: 'peerMessage', peer: 1, message: Buffer.from([2]) },
      { kind: 'hostMessage', message: Buffer.from([1]) },
    ]);
    expect(await invoke(host, IPC_CHANNELS.dropPeer, 1)).toEqual(success(null));
    await until(() => host.events.length === 3 && guest.events.length === 3);
    expect([host.events[2], guest.events[2]]).toEqual([
      { kind: 'peerLeft', peer: 1 },
      { kind: 'ended', reason: 'WIRE_CLOSED' },
    ]);
    expect(await invoke(host, IPC_CHANNELS.stopCollaboration)).toEqual(success(null));
    expect(await invoke(guest, IPC_CHANNELS.stopCollaboration)).toEqual(success(null));
    expect([mdnsFake.record.servicesStopped, mdnsFake.record.destroyed]).toEqual([1, 1]);
  });

  it('tells the host each new code and refuses to drop a guest that is not there', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = new FakePage();
    const shared = (await shareFrom(host)) as { ok: true; value: { code: string; port: number } };
    const wrong = shared.value.code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    const guests = Array.from({ length: 5 }, () => new FakePage());
    for (const [index, guest] of guests.entries()) {
      await invoke(guest, IPC_CHANNELS.joinPlan, {
        address: LOOPBACK,
        port: shared.value.port,
        code: wrong,
        participantId: `p${String(index)}`,
        name: 'Someone',
      });
    }
    await until(() => host.events.some((event) => event.kind === 'codeChanged'));
    expect(host.events.map((event) => event.kind)).toEqual(['codeChanged']);
    expect(await invoke(host, IPC_CHANNELS.dropPeer, 7)).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    expect(errors.mock.calls).toEqual([['The page asked to drop a guest that is not connected.']]);
    forget(host as never);
    for (const guest of guests) {
      forget(guest as never);
    }
    await until(() => mdnsFake.record.destroyed === 1);
  });

  it('copies the code of the plan a window shares, and refuses a window that shares nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const idle = new FakePage();
    expect(await invoke(idle, IPC_CHANNELS.copyJoinCode)).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    const host = new FakePage();
    const shared = (await shareFrom(host)) as { ok: true; value: { code: string } };
    expect(await invoke(host, IPC_CHANNELS.copyJoinCode)).toEqual(success(null));
    uncopyable = shared.value.code;
    expect(await invoke(host, IPC_CHANNELS.copyJoinCode)).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    expect([copied, errors.mock.calls]).toEqual([
      [shared.value.code],
      [
        ['A page asked to copy a join code without sharing a plan.'],
        ['The join code could not be copied:', new Error('Clipboard unavailable')],
      ],
    ]);
    forget(host as never);
    await until(() => mdnsFake.record.destroyed === 1);
  });

  it('lets a window join again once its connection ended, as after a wrong code', async () => {
    const host = new FakePage();
    const guest = new FakePage();
    const shared = (await shareFrom(host)) as { ok: true; value: { code: string; port: number } };
    const request = {
      address: LOOPBACK,
      port: shared.value.port,
      code: shared.value.code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA',
      participantId: 'lea',
      name: 'Léa',
    };
    expect(await invoke(guest, IPC_CHANNELS.joinPlan, request)).toEqual(success(null));
    await until(() => guest.events.length === 1);
    expect(
      await invoke(guest, IPC_CHANNELS.joinPlan, { ...request, code: shared.value.code }),
    ).toEqual(success(null));
    await until(() => guest.events.length === 2);
    expect(guest.events).toEqual([{ kind: 'ended', reason: 'WRONG_CODE' }, { kind: 'connected' }]);
    forget(host as never);
    forget(guest as never);
    await until(() => mdnsFake.record.destroyed === 1);
  });

  it('refuses names and requests that are not valid', async () => {
    const page = new FakePage();
    await expect(invoke(page, IPC_CHANNELS.sharePlan, '', 'Camille')).rejects.toThrow(
      'Request refused',
    );
    await expect(invoke(page, IPC_CHANNELS.sharePlan, 'Thesis', 7)).rejects.toThrow(
      'Request refused',
    );
    const valid = { address: LOOPBACK, port: 1, code: 'K7Q4MZ', participantId: 'lea', name: 'Léa' };
    for (const request of [
      null,
      { ...valid, address: 7 },
      { ...valid, port: '1' },
      { ...valid, code: 'K7Q4M' },
      { ...valid, code: 7 },
      { ...valid, participantId: 'a b' },
      { ...valid, name: '' },
    ]) {
      await expect(invoke(page, IPC_CHANNELS.joinPlan, request)).rejects.toThrow('Request refused');
    }
    await expect(invoke(page, IPC_CHANNELS.findPlans, 'yes')).rejects.toThrow('Request refused');
  });

  it('tells a page that the address or the port typed cannot name a host, without joining', async () => {
    const page = new FakePage();
    const valid = { address: LOOPBACK, port: 1, code: 'K7Q4MZ', participantId: 'lea', name: 'Léa' };
    for (const request of [
      { ...valid, address: 'a b' },
      { ...valid, port: 0 },
      { ...valid, port: 65_536 },
      { ...valid, port: 1.5 },
    ]) {
      expect(await invoke(page, IPC_CHANNELS.joinPlan, request)).toEqual({
        ok: false,
        error: { code: 'INVALID_ADDRESS' },
      });
    }
    expect(await invoke(page, IPC_CHANNELS.stopCollaboration)).toEqual(success(null));
  });

  it('opens the shared plan of a window that joined one only, checking it in the worker', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const page = new FakePage();
    expect(await invoke(page, IPC_CHANNELS.openSharedPlan, Uint8Array.of(1))).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    expect(errors.mock.calls).toEqual([['A page opened a shared plan without having joined one.']]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await invoke(page, IPC_CHANNELS.joinPlan, {
      address: LOOPBACK,
      port: await freePort(),
      code: 'K7Q4MZ',
      participantId: 'lea',
      name: 'Léa',
    });
    expect(await invoke(page, IPC_CHANNELS.openSharedPlan, Uint8Array.of(1))).toEqual(
      success({
        state: Uint8Array.of(1),
        documentId: TEST_DOCUMENT_ID,
        fileName: '',
        warnings: [],
      }),
    );
    expect(tasks).toEqual([{ kind: 'readSharedState', state: Uint8Array.of(1) }]);
    await expect(invoke(page, IPC_CHANNELS.openSharedPlan, 'state')).rejects.toThrow(
      'Request refused',
    );
    forget(page as never);
  });

  it('follows the plans nearby while asked, and stops', async () => {
    const page = new FakePage();
    expect(await invoke(page, IPC_CHANNELS.findPlans, true)).toEqual(success(null));
    mdnsFake.record.listeners.get('up')?.({
      name: 'Tasklace 1',
      fqdn: 'one',
      port: 47_313,
      addresses: ['192.168.1.24'],
      txt: { v: '1', plan: 'Thesis', host: 'Camille' },
    });
    expect(page.events).toEqual([
      {
        kind: 'nearbyPlans',
        plans: [
          {
            key: 'one',
            planName: 'Thesis',
            hostName: 'Camille',
            addresses: ['192.168.1.24'],
            port: 47_313,
          },
        ],
      },
    ]);
    expect(await invoke(page, IPC_CHANNELS.findPlans, false)).toEqual(success(null));
    expect(mdnsFake.record.browsersStopped).toBe(1);
    page.destroyed = true;
    mdnsFake.record.listeners.get('up')?.({
      name: 'x',
      fqdn: 'two',
      port: 1,
      addresses: ['10.0.0.1'],
      txt: { v: '1', plan: 'B', host: 'C' },
    });
    expect(page.events).toHaveLength(1);
  });

  it('logs a message of the page of another shape, and one it cannot send', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const page = new FakePage();
    ipcMain.send(IPC_CHANNELS.collaborationSend, { sender: page }, 1.5, Uint8Array.of(1));
    ipcMain.send(IPC_CHANNELS.collaborationSend, { sender: page }, 'host', 'text');
    ipcMain.send(IPC_CHANNELS.collaborationSend, { sender: page }, 'host', Uint8Array.of(1));
    ipcMain.send(IPC_CHANNELS.collaborationSend, { sender: page }, 3, Uint8Array.of(1));
    expect(errors.mock.calls).toEqual([
      ['The page sent a message of the shared plan of an unexpected shape.'],
      ['The page sent a message of the shared plan of an unexpected shape.'],
    ]);
    expect(warnings.mock.calls).toEqual([
      ['A message of the shared plan could not be sent: NO_SUCH_PEER.'],
      ['A message of the shared plan could not be sent: NO_SUCH_PEER.'],
    ]);
  });

  it('shares even when the network refuses the announcement, telling it in the log', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = new Error('No multicast');
    mdnsFake.mdns = {
      ...mdnsFake.mdns,
      publish: () => {
        throw failure;
      },
    };
    const page = new FakePage();
    const shared = (await shareFrom(page)) as { ok: boolean };
    expect(shared.ok).toBe(true);
    expect(warnings.mock.calls).toEqual([
      ['The shared plan could not be announced on the network:', failure],
    ]);
    expect(await invoke(page, IPC_CHANNELS.stopCollaboration)).toEqual(success(null));
  });
});

describe('the connection of a window to a host', () => {
  /** Builds a fake connection to a host. */
  const fakeClient = () => ({ send: () => success(null), close: () => undefined });

  it('forgets a window whose connection ended at once, and keeps a newer connection when an older one ends late', () => {
    const sharings = new Map<WebContents, WindowSharing>();
    const page = new FakePage() as unknown as WebContents;
    startGuest(sharings, page, (ended) => {
      ended();
      return fakeClient();
    });
    expect(sharings.size).toBe(0);
    let endOlder = (): void => undefined;
    startGuest(sharings, page, (ended) => {
      endOlder = ended;
      return fakeClient();
    });
    sharings.delete(page);
    const newer = fakeClient();
    startGuest(sharings, page, () => newer);
    endOlder();
    expect(sharings.get(page)).toEqual({ kind: 'guest', client: newer });
  });
});

describe('the private addresses of this computer', () => {
  it('lists the private addresses of its interfaces, IPv4 first, without loopback or public ones', () => {
    /** Builds one address of a network interface as the system lists it. */
    const entry = (address: string, family: 'IPv4' | 'IPv6', internal = false) => ({
      address,
      family,
      internal,
      netmask: '',
      mac: '',
      cidr: null,
      ...(family === 'IPv6' ? { scopeid: 0 } : {}),
    });
    expect(
      privateAddressesOf({
        lo: [entry('127.0.0.1', 'IPv4', true)],
        wifi: [entry('fe80::1', 'IPv6'), entry('192.168.1.24', 'IPv4'), entry('8.8.8.8', 'IPv4')],
        none: undefined,
      } as never),
    ).toEqual(['192.168.1.24', 'fe80::1']);
  });
});
