import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireParticipantId } from '../../core/collaboration/participants';
import { tokenDigestOf } from '../../core/collaboration/secure/link';
import { sharingIdOf } from '../../core/collaboration/succession';
import { MAX_PORT_ATTEMPTS } from '../../core/limits';
import type { Introduction } from '../../core/collaboration/secure/link';
import type { CollaborationEvent } from '../../preload/bridge-contract';
import type { AnnouncedService, Mdns } from './discovery';
import type { StartTimer } from './secure-connection';
import { createWindowSharing, type WindowSharing } from './window-sharing';
import { startHostServer } from './host-server';
import { systemRandomBytes } from './aes-gcm';
import { freePort, LOOPBACK, spacedClock, until } from '../testing/plan-host';

const RANGE_ATTEMPTS = 16;
const NAMES = { planName: 'Thesis', hostName: 'Someone' };
const windows: WindowSharing[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(windows.splice(0).map((window) => window.stop()));
});

/** Listens on a port of every address, giving the server or null when the port is taken. */
function listenOrNull(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(null);
    });
    server.listen(port, '::', () => {
      resolve(server);
    });
  });
}

/** Stops listening on every server given. */
function closeAll(servers: readonly (Server | null)[]): Promise<void> {
  return Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (server === null) {
            resolve();
            return;
          }
          server.close(() => {
            resolve();
          });
        }),
    ),
  ).then(() => undefined);
}

/** Takes a range of consecutive ports on every address, as other programs would, so that no server can listen on any of them, trying another range when one of them is already taken by another test. */
async function occupiedPorts(): Promise<{
  readonly first: number;
  readonly free: () => Promise<void>;
}> {
  for (let attempt = 0; attempt < RANGE_ATTEMPTS; attempt += 1) {
    const first = await freePort();
    const servers = await Promise.all(
      Array.from({ length: MAX_PORT_ATTEMPTS }, (_unused, index) => listenOrNull(first + index)),
    );
    if (servers.every((server) => server !== null)) {
      return { first, free: () => closeAll(servers) };
    }
    await closeAll(servers);
  }
  throw new Error('No range of free ports was found.');
}

/** Builds a network shared by the windows of the test, which can be split in halves that do not hear each other and healed, every window then hearing what the others announce. */
function sharedNetwork() {
  const services = new Map<string, { readonly service: AnnouncedService; readonly half: string }>();
  const browsers = new Set<{
    readonly half: () => string;
    readonly handlers: Map<'up' | 'down', (service: AnnouncedService) => void>;
  }>();
  let isHealed = true;
  const published: ((name: string) => void)[] = [];
  /** Tells whether a browser on a half hears a service announced on another. */
  const hears = (browserHalf: string, serviceHalf: string): boolean =>
    isHealed || browserHalf === serviceHalf;
  /** Gives the mDNS a window sees from its half of the network. */
  const view = (half: () => string): Mdns => ({
    publish: (options) => {
      const service: AnnouncedService = {
        name: options.name,
        fqdn: `${options.name}._tasklace._tcp.local`,
        port: options.port,
        addresses: [LOOPBACK],
        txt: options.txt,
      };
      const announced = { service, half: half() };
      services.set(service.fqdn, announced);
      published.forEach((listener) => {
        listener(service.name);
      });
      browsers.forEach((browser) => {
        if (hears(browser.half(), announced.half)) {
          browser.handlers.get('up')?.(service);
        }
      });
      return {
        stop: (done) => {
          services.delete(service.fqdn);
          browsers.forEach((browser) => {
            browser.handlers.get('down')?.(service);
          });
          done?.();
        },
      };
    },
    find: () => {
      const browser = {
        half,
        handlers: new Map<'up' | 'down', (service: AnnouncedService) => void>(),
      };
      browsers.add(browser);
      return {
        on: (event, handler) => {
          browser.handlers.set(event, handler);
          if (event === 'up') {
            queueMicrotask(() => {
              services.forEach((announced) => {
                if (hears(half(), announced.half)) {
                  handler(announced.service);
                }
              });
            });
          }
          return undefined;
        },
        stop: () => {
          browsers.delete(browser);
        },
      };
    },
  });
  return {
    view,
    announced: () => [...services.values()].map(({ service }) => service.name),
    whenPublished: (listener: (name: string) => void) => {
      published.push(listener);
    },
    split: () => {
      isHealed = false;
    },
    heal: () => {
      isHealed = true;
      browsers.forEach((browser) => {
        services.forEach((announced) => {
          browser.handlers.get('up')?.(announced.service);
        });
      });
    },
  };
}

/** Fires at once the timers that start right away and keeps the others, as the first turn of a succession. */
const firstTurnsOnly: StartTimer = (milliseconds, onEnd) => {
  let isStopped = false;
  if (milliseconds === 0) {
    queueMicrotask(() => {
      if (!isStopped) {
        onEnd();
      }
    });
  }
  return () => {
    isStopped = true;
  };
};

/** Opens a window on a half of the shared network, recording what it tells its page. */
function windowOn(network: ReturnType<typeof sharedNetwork>, instance: string, half = 'a') {
  const mdns = network.view(() => half);
  const told: CollaborationEvent[] = [];
  const window = createWindowSharing({
    tell: (event) => told.push(event),
    startTimer: firstTurnsOnly,
    randomBytes: systemRandomBytes,
    now: spacedClock(),
    mdns: () => mdns,
    addresses: () => [LOOPBACK],
    instance: () => instance,
  });
  windows.push(window);
  return { window, told, kinds: () => told.map((event) => event.kind) };
}

/** Tells whether a window joined a host and holds the key of the plan. */
function holdsKey(window: WindowSharing): boolean {
  const state = window.state();
  return state.kind === 'guest' && state.session.planKey() !== null;
}

/** Gives who a person is, with the port it would host on. */
function identity(id: string, port: number): Introduction {
  return {
    participantId: requireParticipantId(id),
    name: id,
    token: id.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a'),
    endpoint: { addresses: [LOOPBACK], port },
  };
}

/** Does what the page of a host does for a person who comes back allowed to edit: lets it send changes, then sends it a first message, once it joined again after the joins already seen. */
async function letTheProbeIn(
  window: WindowSharing,
  told: readonly CollaborationEvent[],
  seen: number,
): Promise<void> {
  /** Lists the joins the host told so far. */
  const joins = () => told.filter((event) => event.kind === 'peerJoined');
  await until(() => joins().length > seen);
  const state = window.state();
  const joined = joins().at(-1);
  const peer =
    state.kind === 'hosting' && joined?.kind === 'peerJoined'
      ? state.hosting.peers.get(joined.peer)
      : undefined;
  peer?.allowEditing();
  peer?.send(Uint8Array.of(1));
}

/** Makes Léa host a plan she took over from Camille, who left, Camille being known to her as the first host. */
async function takenOverHost(network: ReturnType<typeof sharedNetwork>) {
  const camille = windowOn(network, 'camille');
  const lea = windowOn(network, 'lea', 'b');
  const [hostPort, leaPort] = [await freePort(), await freePort()];
  const hosted = await camille.window.host(NAMES, identity('camille', hostPort), hostPort);
  if (!hosted.ok) {
    throw new Error(hosted.error);
  }
  lea.window.join(
    { address: LOOPBACK, port: hosted.value.port, code: hosted.value.code },
    identity('lea', leaPort),
  );
  await until(() => holdsKey(lea.window));
  network.split();
  const known = [
    {
      participantId: 'camille',
      tokenDigest: tokenDigestOf(identity('camille', hostPort).token),
      rank: 0,
      canEdit: true,
    },
  ];
  expect(
    lea.window.succeed([{ participantId: 'lea', rank: 1, endpoint: null }], NAMES, leaPort, known),
  ).toBe(true);
  await until(() => lea.kinds().includes('becameHost'));
  await camille.window.stop();
  const state = lea.window.state();
  if (state.kind !== 'hosting') {
    throw new Error('Léa does not host.');
  }
  return { lea, planKey: state.hosting.server.planKey() };
}

/** Announces on a half of the network a host of the plan of a key, older than anyone, at a port. */
function announceOlder(
  network: ReturnType<typeof sharedNetwork>,
  planKey: Uint8Array,
  port: number,
  half = 'b',
): void {
  network
    .view(() => half)
    .publish({
      name: 'Tasklace aaaa',
      type: 'tasklace',
      port,
      txt: { v: '1', plan: 'Thesis', host: 'Mallory', share: sharingIdOf(planKey), rank: '0' },
    });
}

describe('a shared plan whose host changes', () => {
  it('lets the oldest guest host once the host leaves, the other guest finding it on the network', async () => {
    const network = sharedNetwork();
    const camille = windowOn(network, 'camille');
    const lea = windowOn(network, 'lea');
    const noah = windowOn(network, 'noah');
    const [hostPort, leaPort, noahPort] = [await freePort(), await freePort(), await freePort()];
    const hosted = await camille.window.host(NAMES, identity('camille', hostPort), hostPort);
    if (!hosted.ok) {
      throw new Error(hosted.error);
    }
    const target = { address: LOOPBACK, port: hosted.value.port, code: hosted.value.code };
    lea.window.join(target, identity('lea', leaPort));
    noah.window.join(target, identity('noah', noahPort));
    await until(() => holdsKey(lea.window) && holdsKey(noah.window));
    await camille.window.stop();
    await until(() => lea.kinds().includes('hostLeft') && noah.kinds().includes('hostLeft'));
    const queue = [
      { participantId: 'lea', rank: 1, endpoint: { addresses: [LOOPBACK], port: leaPort } },
      { participantId: 'noah', rank: 2, endpoint: { addresses: [LOOPBACK], port: noahPort } },
    ];
    expect(lea.window.succeed(queue, NAMES, leaPort, [])).toBe(true);
    expect(noah.window.succeed(queue, NAMES, noahPort, [])).toBe(true);
    await until(() => lea.kinds().includes('becameHost') && noah.kinds().at(-1) === 'connected');
    await until(() => lea.kinds().includes('peerJoined'));
    expect([lea.window.state().kind, noah.window.state().kind]).toEqual(['hosting', 'guest']);
    await lea.window.stop();
    await until(() => noah.kinds().at(-1) === 'hostLeft');
  });

  it('makes the newer of two hosts of the same plan give way and join the older one once the network heals', async () => {
    const network = sharedNetwork();
    const older = windowOn(network, 'older', 'a');
    const newer = windowOn(network, 'newer', 'b');
    const [olderPort, newerPort] = [await freePort(), await freePort()];
    const hosted = await older.window.host(NAMES, identity('camille', olderPort), olderPort);
    if (!hosted.ok) {
      throw new Error(hosted.error);
    }
    newer.window.join(
      { address: LOOPBACK, port: hosted.value.port, code: hosted.value.code },
      identity('lea', newerPort),
    );
    await until(() => holdsKey(newer.window));
    network.split();
    const alone = [{ participantId: 'lea', rank: 1, endpoint: null }];
    const known = [
      {
        participantId: 'camille',
        tokenDigest: tokenDigestOf(identity('camille', olderPort).token),
        rank: 0,
        canEdit: true,
      },
    ];
    expect(newer.window.succeed(alone, NAMES, newerPort, known)).toBe(true);
    await until(() => newer.kinds().includes('becameHost'));
    const seen = older.told.filter((event) => event.kind === 'peerJoined').length;
    network.heal();
    await letTheProbeIn(older.window, older.told, seen);
    await until(() => newer.kinds().includes('yielded'));
    await until(
      () => newer.kinds().at(-1) === 'connected' && newer.window.state().kind === 'guest',
    );
    expect([older.window.state().kind, newer.kinds().slice(-3)]).toEqual([
      'hosting',
      ['becameHost', 'yielded', 'connected'],
    ]);
  });

  it('starts the search again with a new queue, stops it when the page leaves, and searches without mDNS when the network refuses it', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const network = sharedNetwork();
    const camille = windowOn(network, 'camille');
    const lea = windowOn(network, 'lea');
    const [hostPort, leaPort] = [await freePort(), await freePort()];
    const hosted = await camille.window.host(NAMES, identity('camille', hostPort), hostPort);
    if (!hosted.ok) {
      throw new Error(hosted.error);
    }
    lea.window.join(
      { address: LOOPBACK, port: hosted.value.port, code: hosted.value.code },
      identity('lea', leaPort),
    );
    await until(() => holdsKey(lea.window));
    const later = [{ participantId: 'noah', rank: 2, endpoint: null }];
    expect(lea.window.succeed(later, NAMES, leaPort, [])).toBe(true);
    expect(lea.window.succeed(later, NAMES, leaPort, [])).toBe(true);
    expect(lea.window.state().kind).toBe('searching');
    await lea.window.stop();
    expect(lea.window.state().kind).toBe('idle');
    const deaf = createWindowSharing({
      tell: () => undefined,
      startTimer: firstTurnsOnly,
      randomBytes: systemRandomBytes,
      now: spacedClock(),
      mdns: () => {
        throw new Error('No multicast');
      },
      addresses: () => [LOOPBACK],
      instance: () => 'deaf',
    });
    windows.push(deaf);
    deaf.join(
      { address: LOOPBACK, port: hosted.value.port, code: hosted.value.code },
      identity('noah', 1),
    );
    await until(() => holdsKey(deaf));
    expect(deaf.succeed(later, NAMES, 1, [])).toBe(true);
    expect(warnings.mock.calls).toEqual([
      [
        'The shared plan could not look for its next host on the network:',
        new Error('No multicast'),
      ],
    ]);
  });

  it('stops hosting again at once when the window stopped while the server was starting', async () => {
    const network = sharedNetwork();
    const camille = windowOn(network, 'camille');
    const lea = windowOn(network, 'lea');
    const [hostPort, leaPort] = [await freePort(), await freePort()];
    const hosted = await camille.window.host(NAMES, identity('camille', hostPort), hostPort);
    if (!hosted.ok) {
      throw new Error(hosted.error);
    }
    lea.window.join(
      { address: LOOPBACK, port: hosted.value.port, code: hosted.value.code },
      identity('lea', leaPort),
    );
    await until(() => holdsKey(lea.window));
    await camille.window.stop();
    await until(() => lea.kinds().includes('hostLeft'));
    const stopping: { promise: Promise<void> | null } = { promise: null };
    network.whenPublished((name) => {
      if (name === 'Tasklace lea') {
        stopping.promise = lea.window.stop();
      }
    });
    const queue = [{ participantId: 'lea', rank: 1, endpoint: null }];
    expect(lea.window.succeed(queue, NAMES, leaPort, [])).toBe(true);
    await until(() => stopping.promise !== null);
    await stopping.promise;
    await until(() => network.announced().length === 0);
    const next = await camille.window.host(NAMES, identity('camille', leaPort), leaPort);
    expect([
      lea.window.state().kind,
      lea.kinds().includes('becameHost'),
      next.ok && next.value.port,
    ]).toEqual(['idle', false, leaPort]);
  });

  it('tells why it cannot host when every port of its range is taken, and lets its turn pass during a search', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const network = sharedNetwork();
    const camille = windowOn(network, 'camille');
    const lea = windowOn(network, 'lea');
    const taken = await occupiedPorts();
    try {
      expect(
        await camille.window.host(NAMES, identity('camille', taken.first), taken.first),
      ).toEqual({
        ok: false,
        error: 'NO_FREE_PORT',
      });
      const hostPort = await freePort();
      const hosted = await camille.window.host(NAMES, identity('camille', hostPort), hostPort);
      if (!hosted.ok) {
        throw new Error(hosted.error);
      }
      lea.window.join(
        { address: LOOPBACK, port: hosted.value.port, code: hosted.value.code },
        identity('lea', taken.first),
      );
      expect(lea.window.succeed([], NAMES, taken.first, [])).toBe(false);
      await until(() => holdsKey(lea.window));
      network.split();
      const queue = [
        { participantId: 'lea', rank: 1, endpoint: null },
        { participantId: 'noah', rank: 2, endpoint: { addresses: [LOOPBACK], port: taken.first } },
      ];
      expect(lea.window.succeed(queue, NAMES, taken.first, [])).toBe(true);
      await until(() => warnings.mock.calls.length === 2);
      expect(warnings.mock.calls).toEqual([
        ['The shared plan could not be hosted here: NO_FREE_PORT.'],
        ['This window could not host the shared plan; it keeps looking for the next host.'],
      ]);
      expect(lea.window.state().kind).toBe('searching');
    } finally {
      await taken.free();
    }
  });

  it('keeps an attempt that fails while it searches, to try it again later', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const network = sharedNetwork();
    const camille = windowOn(network, 'camille');
    const lea = windowOn(network, 'lea', 'b');
    const [hostPort, nobody] = [await freePort(), await freePort()];
    const hosted = await camille.window.host(NAMES, identity('camille', hostPort), hostPort);
    if (!hosted.ok) {
      throw new Error(hosted.error);
    }
    lea.window.join(
      { address: LOOPBACK, port: hosted.value.port, code: hosted.value.code },
      identity('lea', nobody),
    );
    await until(() => holdsKey(lea.window));
    network.split();
    const queue = [
      {
        participantId: 'noah',
        rank: 1,
        endpoint: { addresses: [LOOPBACK, 'a b', 'evil.example.com', '8.8.8.8'], port: nobody },
      },
    ];
    expect(lea.window.succeed(queue, NAMES, nobody, [])).toBe(true);
    const searching = lea.window.state();
    await until(() => warnings.mock.calls.length === 1);
    expect([
      warnings.mock.calls,
      searching.kind === 'searching' ? searching.attempts.size : -1,
    ]).toEqual([
      [
        [
          `The connection to the shared plan failed: connect ECONNREFUSED 127.0.0.1:${String(nobody)}`,
        ],
      ],
      1,
    ]);
    expect([lea.window.state().kind, lea.kinds()]).toEqual(['searching', ['connected']]);
  });

  it('keeps hosting when an announcement of the same plan with an older rank comes from someone without the key', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const network = sharedNetwork();
    const { lea, planKey } = await takenOverHost(network);
    const nobody = await freePort();
    announceOlder(network, planKey, nobody);
    const refused = `The connection to the shared plan failed: connect ECONNREFUSED 127.0.0.1:${String(nobody)}`;
    await until(() => warnings.mock.calls.some(([text]) => text === refused));
    expect(lea.window.state().kind).toBe('hosting');
  });

  it('closes its attempt to join an older host once the window stops hosting', async () => {
    const network = sharedNetwork();
    const { lea, planKey } = await takenOverHost(network);
    let open = 0;
    let isReached = false;
    const silent = createServer((socket) => {
      open += 1;
      isReached = true;
      socket.resume();
      socket.on('close', () => {
        open -= 1;
      });
    });
    await new Promise<void>((resolve) => silent.listen(0, LOOPBACK, resolve));
    const address = silent.address();
    announceOlder(
      network,
      planKey,
      typeof address === 'object' && address !== null ? address.port : 0,
    );
    await until(() => isReached);
    expect(open).toBe(1);
    await lea.window.stop();
    await until(() => open === 0);
    await new Promise<void>((resolve) => {
      silent.close(() => {
        resolve();
      });
    });
    expect([lea.window.state().kind, open]).toEqual(['idle', 0]);
  });

  it('keeps hosting and logs why when the older host announced refuses the key', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const network = sharedNetwork();
    const { lea, planKey } = await takenOverHost(network);
    const mallory = windowOn(network, 'mallory', 'b');
    const otherPort = await freePort();
    const other = await mallory.window.host(NAMES, identity('mallory', otherPort), otherPort);
    if (!other.ok) {
      throw new Error(other.error);
    }
    warnings.mockClear();
    announceOlder(network, planKey, other.value.port);
    await until(() => warnings.mock.calls.length === 1);
    expect([lea.window.state().kind, warnings.mock.calls]).toEqual([
      'hosting',
      [['An older host of the shared plan could not be joined: WRONG_KEY.']],
    ]);
  });

  it('keeps hosting when an older host holding the key cannot prove it is an older person allowed to edit', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const network = sharedNetwork();
    const { lea, planKey } = await takenOverHost(network);
    const port = await freePort();
    const impostor = await startHostServer({
      port,
      planKey,
      knownTokens: new Map(),
      identity: identity('mallory', port),
      startTimer: firstTurnsOnly,
      randomBytes: systemRandomBytes,
      now: spacedClock(),
      events: {
        joined: (peer) => {
          peer.allowEditing();
          peer.send(Uint8Array.of(1));
        },
        message: () => undefined,
        left: () => undefined,
        codeChanged: () => undefined,
      },
    });
    if (!impostor.ok) {
      throw new Error(impostor.error);
    }
    announceOlder(network, planKey, impostor.value.port);
    const unproven = 'An older host of the shared plan could not prove who it is.';
    await until(() => warnings.mock.calls.some(([text]) => text === unproven));
    expect([lea.window.state().kind, lea.kinds().includes('yielded')]).toEqual(['hosting', false]);
    await impostor.value.close();
  });

  it('never gives way when it shared the plan first', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const network = sharedNetwork();
    const camille = windowOn(network, 'camille');
    const hostPort = await freePort();
    const hosted = await camille.window.host(NAMES, identity('camille', hostPort), hostPort);
    const state = camille.window.state();
    if (!hosted.ok || state.kind !== 'hosting') {
      throw new Error('Camille could not host.');
    }
    announceOlder(network, state.hosting.server.planKey(), hosted.value.port + 1, 'a');
    await until(() => warnings.mock.calls.length === 1);
    expect([camille.window.state().kind, warnings.mock.calls]).toEqual([
      'hosting',
      [['A host of the same plan claims to be older, but this window shared it first.']],
    ]);
  });

  it('refuses to look for the next host without a key of the plan', () => {
    const lone = windowOn(sharedNetwork(), 'lone');
    expect(lone.window.succeed([], NAMES, 1, [])).toBe(false);
  });
});
