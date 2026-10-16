import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireParticipantId } from '../../core/collaboration/participants';
import { MAX_PORT_ATTEMPTS } from '../../core/limits';
import type { Introduction } from '../../core/collaboration/secure/link';
import type { CollaborationEvent } from '../../preload/bridge-contract';
import type { AnnouncedService, Mdns } from './discovery';
import type { StartTimer } from './secure-connection';
import { createWindowSharing, type WindowSharing } from './window-sharing';

const LOOPBACK = '127.0.0.1';
const RANGE_ATTEMPTS = 16;
const NAMES = { planName: 'Thesis', hostName: 'Someone' };
const windows: WindowSharing[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(windows.splice(0).map((window) => window.stop()));
});

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

/** Waits until a condition holds. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Builds a network shared by the windows of the test, which can be split in halves that do not hear each other and healed, every window then hearing what the others announce. */
function sharedNetwork() {
  const services = new Map<string, { readonly service: AnnouncedService; readonly half: string }>();
  const browsers = new Set<{
    readonly half: () => string;
    readonly handlers: Map<'up' | 'down', (service: AnnouncedService) => void>;
  }>();
  let isHealed = true;
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
    expect(lea.window.succeed(queue, NAMES, leaPort, new Map())).toBe(true);
    expect(noah.window.succeed(queue, NAMES, noahPort, new Map())).toBe(true);
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
    expect(newer.window.succeed(alone, NAMES, newerPort, new Map())).toBe(true);
    await until(() => newer.kinds().includes('becameHost'));
    network.heal();
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
    expect(lea.window.succeed(later, NAMES, leaPort, new Map())).toBe(true);
    expect(lea.window.succeed(later, NAMES, leaPort, new Map())).toBe(true);
    expect(lea.window.state().kind).toBe('searching');
    await lea.window.stop();
    expect(lea.window.state().kind).toBe('idle');
    const deaf = createWindowSharing({
      tell: () => undefined,
      startTimer: firstTurnsOnly,
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
    expect(deaf.succeed(later, NAMES, 1, new Map())).toBe(true);
    expect(warnings.mock.calls).toEqual([
      [
        'The shared plan could not look for its next host on the network:',
        new Error('No multicast'),
      ],
    ]);
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
      expect(lea.window.succeed([], NAMES, taken.first, new Map())).toBe(false);
      await until(() => holdsKey(lea.window));
      network.split();
      const queue = [
        { participantId: 'lea', rank: 1, endpoint: null },
        { participantId: 'noah', rank: 2, endpoint: { addresses: [LOOPBACK], port: taken.first } },
      ];
      expect(lea.window.succeed(queue, NAMES, taken.first, new Map())).toBe(true);
      await until(() => warnings.mock.calls.length === 2);
      expect(warnings.mock.calls).toEqual([
        ['The shared plan could not be hosted here: NO_FREE_PORT.'],
        ['This window could not host the shared plan; the next one in turn will.'],
      ]);
      expect(lea.window.state().kind).toBe('searching');
    } finally {
      await taken.free();
    }
  });

  it('forgets an attempt that fails while it keeps searching', async () => {
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
      { participantId: 'noah', rank: 1, endpoint: { addresses: [LOOPBACK, 'a b'], port: nobody } },
    ];
    expect(lea.window.succeed(queue, NAMES, nobody, new Map())).toBe(true);
    const searching = lea.window.state();
    await until(() => warnings.mock.calls.length === 1);
    await until(() => searching.kind === 'searching' && searching.attempts.size === 0);
    expect([
      warnings.mock.calls,
      searching.kind === 'searching' ? searching.attempts.size : -1,
    ]).toEqual([
      [
        [
          `The connection to the shared plan failed: connect ECONNREFUSED 127.0.0.1:${String(nobody)}`,
        ],
      ],
      0,
    ]);
    expect([lea.window.state().kind, lea.kinds()]).toEqual(['searching', ['connected']]);
  });

  it('refuses to look for the next host without a key of the plan', () => {
    const lone = windowOn(sharedNetwork(), 'lone');
    expect(lone.window.succeed([], NAMES, 1, new Map())).toBe(false);
  });
});
