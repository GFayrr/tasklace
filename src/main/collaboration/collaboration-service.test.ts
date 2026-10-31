import { requireParticipantId } from '../../core/collaboration/participants';
import { testDigest, testJoinCode, testPlanKey, testToken } from '../../core/testing/secrets';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain as electronIpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { generateJoinCode } from '../../core/collaboration/secure/join-code';
import { tokenDigestOf } from '../../core/collaboration/secure/link';
import { sharingIdOf } from '../../core/collaboration/succession';
import { failure, success } from '../../core/result';
import { TEST_DOCUMENT_ID } from '../../core/testing/project-builder';
import { IPC_CHANNELS, type CollaborationEvent } from '../../preload/bridge-contract';
import type { FileTask } from '../file-tasks';
import type { FakeIpcMain } from '../testing/fake-electron';
import { systemRandomBytes } from './aes-gcm';
import { privateAddressesOf, registerCollaborationHandlers } from './collaboration-service';
import type { AnnouncedService, Mdns } from './discovery';
import { freePort, LOOPBACK, spacedClock, until } from '../testing/plan-host';

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
const KNOWN = [
  { participantId: 'lea', tokenDigest: testDigest('e'.repeat(64)), rank: 1, canEdit: true },
];
const draws: Uint8Array[] = [];

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
  const record = {
    published,
    listeners,
    destroyed: 0,
    browsersStopped: 0,
    servicesStopped: 0,
    onPublish: (): void => undefined,
  };
  const mdns: Mdns = {
    publish: (options) => {
      published.push(options);
      record.onPublish();
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
  draws.length = 0;
  trusted.mockClear();
  ipcMain.handlers.clear();
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
    now: spacedClock(),
    randomBytes: (count) => {
      const drawn = systemRandomBytes(count);
      draws.push(drawn);
      return drawn;
    },
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
  return invoke(page, IPC_CHANNELS.sharePlan, 'Thesis', 'Camille', 'camille');
}

describe('the collaboration service', () => {
  it('forgets guests only for a page that hosts, refusing a list that is not one of identifiers', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = new FakePage();
    expect(await invoke(host, IPC_CHANNELS.forgetGuests, ['lea'])).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
    expect(errors.mock.calls).toEqual([
      ['The page asked to forget guests without hosting a plan.'],
    ]);
    await expect(invoke(host, IPC_CHANNELS.forgetGuests, ['a b'])).rejects.toThrow(
      'Request refused: its content is not valid.',
    );
    await shareFrom(host);
    expect(await invoke(host, IPC_CHANNELS.forgetGuests, ['lea'])).toEqual(success(null));
    expect(await invoke(host, IPC_CHANNELS.stopCollaboration)).toEqual(success(null));
  });

  it('refuses a second share while the first one starts', async () => {
    const page = new FakePage();
    const port = await freePort();
    await invoke(page, IPC_CHANNELS.saveCollaborationSettings, {
      name: 'Camille',
      port,
      firewallNoticeSeen: false,
    });
    const [first, second] = await Promise.all([
      invoke(page, IPC_CHANNELS.sharePlan, 'Thesis', 'Camille', 'camille'),
      invoke(page, IPC_CHANNELS.sharePlan, 'Thesis', 'Camille', 'camille'),
    ]);
    expect([(first as { ok: boolean }).ok, second, mdnsFake.record.published.length]).toEqual([
      true,
      failure({ code: 'ALREADY_SHARING' }),
      1,
    ]);
    expect(await invoke(page, IPC_CHANNELS.stopCollaboration)).toEqual(success(null));
  });

  it('stops a share or a join that was still starting when its page stopped, leaving no server behind', async () => {
    const page = new FakePage();
    const reading = invoke(page, IPC_CHANNELS.sharePlan, 'Thesis', 'Camille', 'camille');
    await invoke(page, IPC_CHANNELS.stopCollaboration);
    const joining = invoke(page, IPC_CHANNELS.joinPlan, {
      address: LOOPBACK,
      port: 47_313,
      code: testJoinCode('K7Q4MZ'),
      participantId: 'lea',
      name: 'Léa',
    });
    await invoke(page, IPC_CHANNELS.stopCollaboration);
    expect([await reading, await joining]).toEqual([
      failure({ code: 'CANCELLED' }),
      failure({ code: 'CANCELLED' }),
    ]);
    mdnsFake.record.onPublish = () => {
      void invoke(page, IPC_CHANNELS.stopCollaboration);
    };
    expect(await shareFrom(page)).toEqual(failure({ code: 'CANCELLED' }));
    expect([mdnsFake.record.published.length, mdnsFake.record.servicesStopped]).toEqual([1, 1]);
  });

  it('reads and keeps the settings, refusing settings of another shape', async () => {
    const page = new FakePage();
    expect(await invoke(page, IPC_CHANNELS.collaborationSettings)).toEqual(
      success({ name: null, port: 47_313, firewallNoticeSeen: false, relayAddress: null }),
    );
    const settings = {
      name: 'Léa',
      port: 50_000,
      firewallNoticeSeen: true,
      relayAddress: 'wss://tasklace.my-school.example',
    };
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
    expect(await invoke(page, IPC_CHANNELS.sharePlan, 'Thesis', 'Camille', 'camille')).toEqual({
      ok: false,
      error: { code: 'READ_FAILED' },
    });
    const joining = {
      address: LOOPBACK,
      port: 1,
      code: testJoinCode('K7Q4MZ'),
      participantId: 'lea',
      name: 'Léa',
    };
    expect([
      await invoke(page, IPC_CHANNELS.joinPlan, joining),
      await invoke(page, IPC_CHANNELS.findNextHost, [], 'Thesis', 'Léa', []),
    ]).toEqual([
      { ok: false, error: { code: 'READ_FAILED' } },
      { ok: false, error: { code: 'READ_FAILED' } },
    ]);
  });

  it('shares a plan, lets a guest join and passes their messages both ways, until the host turns the guest away', async () => {
    const host = new FakePage();
    const guest = new FakePage();
    const shared = (await shareFrom(host)) as {
      ok: true;
      value: { code: string; port: number; addresses: string[]; tokenDigest: string };
    };
    const [hostToken, instance, code, planKey] = draws;
    expect(draws.map((drawn) => drawn.length)).toEqual([32, 8, 6, 32]);
    expect([
      shared.ok,
      shared.value.code,
      shared.value.addresses,
      shared.value.tokenDigest,
    ]).toEqual([
      true,
      generateJoinCode(() => code ?? new Uint8Array()),
      ['192.168.1.24'],
      tokenDigestOf(testToken(bytesToHex(hostToken ?? new Uint8Array()))),
    ]);
    expect(mdnsFake.record.published).toEqual([
      {
        name: `Tasklace ${bytesToHex(instance ?? new Uint8Array())}`,
        type: 'tasklace',
        port: shared.value.port,
        txt: {
          v: '1',
          plan: 'Thesis',
          host: 'Camille',
          share: sharingIdOf(testPlanKey(planKey ?? new Uint8Array())),
          rank: '0',
        },
      },
    ]);
    expect(await invoke(host, IPC_CHANNELS.sharePlan, 'Thesis', 'Camille', 'camille')).toEqual({
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
    const guestTokenAt = draws.length;
    expect(await invoke(guest, IPC_CHANNELS.joinPlan, request)).toEqual(success(null));
    const guestToken = bytesToHex(draws[guestTokenAt] ?? new Uint8Array());
    expect(await invoke(guest, IPC_CHANNELS.joinPlan, request)).toEqual({
      ok: false,
      error: { code: 'ALREADY_SHARING' },
    });
    await until(() => host.events.length === 1 && guest.events.length === 1);
    expect([host.events, guest.events]).toEqual([
      [
        {
          kind: 'peerJoined',
          peer: 1,
          participantId: requireParticipantId('lea'),
          name: 'Léa',
          endpoint: { addresses: ['192.168.1.24'], port: shared.value.port },
          tokenDigest: tokenDigestOf(testToken(guestToken)),
        },
      ],
      [{ kind: 'connected' }],
    ]);
    ipcMain.send(IPC_CHANNELS.collaborationSend, { sender: host }, 1, Uint8Array.of(1));
    ipcMain.send(IPC_CHANNELS.collaborationSend, { sender: guest }, 'host', Uint8Array.of(2));
    await until(() => host.events.length === 2 && guest.events.length === 2);
    expect([host.events[1], guest.events[1]]).toEqual([
      { kind: 'peerMessage', peer: 1, message: Buffer.from([2]) },
      { kind: 'hostMessage', message: Buffer.from([1]) },
    ]);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ipcMain.send(IPC_CHANNELS.collaborationSend, { sender: host }, [1, 7], Uint8Array.of(4));
    ipcMain.send(IPC_CHANNELS.collaborationSend, { sender: host }, [1.5], Uint8Array.of(5));
    await until(() => guest.events.length === 3);
    expect([guest.events[2], warnings.mock.calls, errors.mock.calls]).toEqual([
      { kind: 'hostMessage', message: Buffer.from([4]) },
      [['A message of the shared plan could not be sent: NO_SUCH_PEER.']],
      [['The page sent a message of the shared plan of an unexpected shape.']],
    ]);
    guest.events.splice(2, 1);
    warnings.mockRestore();
    errors.mockRestore();
    expect(await invoke(host, IPC_CHANNELS.allowPeerToEdit, 1)).toEqual(success(null));
    expect(await invoke(host, IPC_CHANNELS.dropPeer, 1)).toEqual(success(null));
    await until(() => host.events.length === 3 && guest.events.length === 3);
    expect([host.events[2], guest.events[2]]).toEqual([
      { kind: 'peerLeft', peer: 1 },
      { kind: 'ended', reason: 'TURNED_AWAY' },
    ]);
    expect(await invoke(host, IPC_CHANNELS.stopCollaboration)).toEqual(success(null));
    expect(await invoke(guest, IPC_CHANNELS.stopCollaboration)).toEqual(success(null));
    expect([
      mdnsFake.record.servicesStopped,
      mdnsFake.record.destroyed,
      mdnsFake.record.published.length,
    ]).toEqual([1, 1, 1]);
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
    expect(await invoke(host, IPC_CHANNELS.allowPeerToEdit, 7)).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    expect(errors.mock.calls).toEqual([
      ['The page asked to drop a guest that is not connected.'],
      ['The page asked to let a guest edit who is not connected.'],
    ]);
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
    const valid = {
      address: LOOPBACK,
      port: 1,
      code: testJoinCode('K7Q4MZ'),
      participantId: 'lea',
      name: 'Léa',
    };
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
    const valid = {
      address: LOOPBACK,
      port: 1,
      code: testJoinCode('K7Q4MZ'),
      participantId: 'lea',
      name: 'Léa',
    };
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
      code: testJoinCode('K7Q4MZ'),
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
      txt: { v: '1', plan: 'Thesis', host: 'Camille', share: 'a'.repeat(32), rank: '0' },
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
      name: requireParticipantId('x'),
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
      publish: () => {
        throw failure;
      },
      find: () => {
        throw failure;
      },
    };
    const page = new FakePage();
    const shared = (await shareFrom(page)) as { ok: boolean };
    expect(shared.ok).toBe(true);
    expect(warnings.mock.calls).toEqual([
      ['The shared plan could not be announced on the network:', failure],
      ['The shared plan could not look for other hosts on the network:', failure],
    ]);
    expect(await invoke(page, IPC_CHANNELS.stopCollaboration)).toEqual(success(null));
  });

  it('looks for the next host of a plan joined with its key, refusing a queue of another shape and a window without the key', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = new FakePage();
    const guest = new FakePage();
    const shared = (await shareFrom(host)) as { ok: true; value: { code: string; port: number } };
    const queue = [
      {
        participantId: requireParticipantId('lea'),
        rank: 1,
        endpoint: { addresses: ['192.168.1.24'], port: 47_313 },
      },
      { participantId: requireParticipantId('noah'), rank: 2, endpoint: null },
    ];
    expect(await invoke(guest, IPC_CHANNELS.findNextHost, queue, 'Thesis', 'Léa', KNOWN)).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    for (const invalid of [
      null,
      [{ participantId: 'a b', rank: 1, endpoint: null }],
      [{ participantId: requireParticipantId('lea'), rank: -1, endpoint: null }],
      [{ participantId: requireParticipantId('lea'), rank: 1, endpoint: { port: 1 } }],
      [{ participantId: requireParticipantId('lea'), rank: 1 }],
      [7],
    ]) {
      await expect(
        invoke(guest, IPC_CHANNELS.findNextHost, invalid, 'Thesis', 'Léa', KNOWN),
      ).rejects.toThrow('Request refused');
    }
    await expect(invoke(guest, IPC_CHANNELS.findNextHost, queue, '', 'Léa', KNOWN)).rejects.toThrow(
      'Request refused',
    );
    for (const tokens of [
      null,
      [{ participantId: 'lea', tokenDigest: 'x', rank: 1, canEdit: true }],
      [{ participantId: 'a b', tokenDigest: testDigest('e'.repeat(64)), rank: 1, canEdit: true }],
      [{ participantId: 'lea', tokenDigest: testDigest('e'.repeat(64)), rank: -1, canEdit: true }],
      [{ participantId: 'lea', tokenDigest: testDigest('e'.repeat(64)), rank: 1, canEdit: 'yes' }],
    ]) {
      await expect(
        invoke(guest, IPC_CHANNELS.findNextHost, queue, 'Thesis', 'Léa', tokens),
      ).rejects.toThrow('Request refused');
    }
    await invoke(guest, IPC_CHANNELS.joinPlan, {
      address: LOOPBACK,
      port: shared.value.port,
      code: shared.value.code,
      participantId: 'lea',
      name: 'Léa',
    });
    await until(() => guest.events.some((event) => event.kind === 'connected'));
    let asked = await invoke(guest, IPC_CHANNELS.findNextHost, queue, 'Thesis', 'Léa', KNOWN);
    while (JSON.stringify(asked) !== JSON.stringify(success(null))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      asked = await invoke(guest, IPC_CHANNELS.findNextHost, queue, 'Thesis', 'Léa', KNOWN);
    }
    expect(asked).toEqual(success(null));
    expect(errors.mock.calls[0]).toEqual([
      'A page looked for the next host without having joined a plan with its key.',
    ]);
    forget(host as never);
    forget(guest as never);
    await until(() => mdnsFake.record.destroyed === 1);
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

describe('a plan shared another way', () => {
  it('is not shared on the network as well, and is left when the page stops sharing', async () => {
    const elsewhere = new Set<unknown>();
    const left: unknown[] = [];
    ipcMain.handlers.clear();
    const registered = registerCollaborationHandlers({
      assertTrusted: trusted,
      userDataFolder: folder,
      runTask: () => Promise.reject(new Error('No task is expected.')),
      createMdns: () => ({ mdns: mdnsFake.mdns, destroy: () => undefined }),
      addresses: () => ['192.168.1.24'],
      copyText: () => Promise.resolve(),
      sharesElsewhere: (sender) => elsewhere.has(sender),
      leaveElsewhere: (sender) => {
        left.push(sender);
      },
    });
    const page = new FakePage();
    elsewhere.add(page);
    expect([
      await invoke(page, IPC_CHANNELS.sharePlan, 'Thesis', 'Camille', 'camille'),
      await invoke(page, IPC_CHANNELS.stopCollaboration),
      left,
      registered.isBusy(page as never),
    ]).toEqual([failure({ code: 'ALREADY_SHARING' }), success(null), [page], false]);
  });
});
