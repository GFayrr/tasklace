import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeMessage } from '../../core/collaboration/messages';
import { createGuest } from '../../core/collaboration/sync';
import { CHANNEL_CHUNK_BYTES, MAX_TASK_NAME_LENGTH } from '../../core/limits';
import { createSharedDocument } from '../../core/shared/shared-document';
import { project, TEST_DOCUMENT_ID, workTask } from '../../core/testing/project-builder';
import { sessionOn } from '../../core/testing/session-copy';
import { messageOf, startPlanHost } from '../testing/plan-host';
import { requireParticipantId } from '../../core/collaboration/participants';
import { FIRST_RECONNECT_MILLISECONDS } from '../../core/collaboration/reconnection';
import type { Introduction } from '../../core/collaboration/secure/link';
import type { CollaborationEvent } from '../../preload/bridge-contract';
import { systemRandomBytes } from './aes-gcm';
import { connectAsGuest } from './guest-client';
import { startGuestSession } from './guest-session';
import { startHostServer, type HostServer } from './host-server';
import type { StartTimer } from './secure-connection';

const LOOPBACK = '127.0.0.1';
const PLAN_KEY = new Uint8Array(32).fill(3);
const LEA: Introduction = {
  participantId: requireParticipantId('lea'),
  name: 'Léa',
  token: 'ab'.repeat(32),
  endpoint: { addresses: [], port: 47_313 },
};
const servers: HostServer[] = [];
const LARGE_PLAN_TASKS = 8_000;
const LARGE_PLAN_SEED = 0x7a5c_1ace;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const XORSHIFT_SHIFTS = [13, 17, 5] as const;
const LARGE_TRANSFER_TIMEOUT_MS = 60_000;
const NAME_DIGITS = 4;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
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

/** Waits until a condition holds. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Starts a relay that passes the bytes of a guest to a host on a port chosen at each connection, and can cut every connection at once as a lost network would, without any closing message, which it also does by itself once the host sent a number of bytes. */
async function relay(target: () => number, cutAfterHostBytes = Number.POSITIVE_INFINITY) {
  const sockets = new Set<Socket>();
  let hostBytes = 0;
  /** Destroys every connection passing through the relay. */
  const cut = (): void => {
    sockets.forEach((socket) => socket.destroy());
    sockets.clear();
  };
  const server: Server = createServer((guestSide) => {
    const hostSide = connect(target(), LOOPBACK);
    sockets.add(guestSide);
    sockets.add(hostSide);
    guestSide.pipe(hostSide).pipe(guestSide);
    guestSide.on('error', () => undefined);
    hostSide.on('error', () => undefined);
    hostSide.on('data', (chunk: Buffer) => {
      hostBytes += chunk.length;
      if (hostBytes > cutAfterHostBytes) {
        cutAfterHostBytes = Number.POSITIVE_INFINITY;
        cut();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    hostBytes: () => hostBytes,
    cut,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Writes names of the longest length from letters drawn with a fixed seed, so that the plan they fill hardly compresses. */
function drawnNames(count: number): string[] {
  let state = LARGE_PLAN_SEED;
  const [left, right, last] = XORSHIFT_SHIFTS;
  /** Draws the next letter. */
  const letter = (): string => {
    state ^= state << left;
    state ^= state >>> right;
    state ^= state << last;
    return LETTERS[(state >>> 0) % LETTERS.length] ?? 'a';
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: MAX_TASK_NAME_LENGTH }, letter).join(''),
  );
}

/** Starts a host with the key of the plan on a port, counting who joins. */
async function host(port: number) {
  const joined: string[] = [];
  const started = await startHostServer({
    port,
    planKey: PLAN_KEY,
    knownTokens: new Map(),
    startTimer: () => () => undefined,
    randomBytes: systemRandomBytes,
    events: {
      joined: (_peer, introduction) => joined.push(introduction.name),
      message: () => undefined,
      left: () => undefined,
      codeChanged: () => undefined,
      planKeyChanged: () => undefined,
    },
  });
  if (!started.ok) {
    throw new Error(started.error);
  }
  servers.push(started.value);
  return { server: started.value, joined };
}

describe('coming back to a host over the network', () => {
  it('joins with the code, then comes back with the key once the network lets it reach the host again', async () => {
    const first = await host(await freePort());
    let target = first.server.port;
    const network = await relay(() => target);
    const told: CollaborationEvent['kind'][] = [];
    const retries: (() => void)[] = [];
    let keys = 0;
    /** Keeps the first attempts to come back for the test to start, and starts no other timer. */
    const startTimer: StartTimer = (milliseconds, onEnd) => {
      if (milliseconds === FIRST_RECONNECT_MILLISECONDS) {
        retries.push(onEnd);
      }
      return () => undefined;
    };
    const session = startGuestSession({
      address: LOOPBACK,
      port: network.port,
      secret: { kind: 'code', code: first.server.code() },
      introduction: LEA,
      startTimer,
      connect: (options) =>
        connectAsGuest({
          ...options,
          randomBytes: systemRandomBytes,
          events: {
            ...options.events,
            planKey: (key) => {
              keys += 1;
              options.events.planKey(key);
            },
          },
        }),
      tell: (event) => told.push(event.kind),
      ended: () => undefined,
    });
    await until(() => keys === 1 && first.joined.length === 1);
    network.cut();
    await until(() => told.includes('reconnecting'));
    const second = await host(await freePort());
    target = second.server.port;
    retries.splice(0).forEach((retry) => {
      retry();
    });
    await until(() => second.joined.length === 1);
    expect([told, second.joined]).toEqual([['connected', 'reconnecting', 'connected'], ['Léa']]);
    session.close();
    network.cut();
    await network.close();
  });

  it('stops trying a host that closes on purpose and tells the page the host left', async () => {
    const shared = await host(await freePort());
    const told: CollaborationEvent['kind'][] = [];
    const timers: number[] = [];
    let keys = 0;
    const session = startGuestSession({
      address: LOOPBACK,
      port: shared.server.port,
      secret: { kind: 'code', code: shared.server.code() },
      introduction: LEA,
      startTimer: (milliseconds) => {
        timers.push(milliseconds);
        return () => undefined;
      },
      connect: (options) =>
        connectAsGuest({
          ...options,
          randomBytes: systemRandomBytes,
          events: {
            ...options.events,
            planKey: (key) => {
              keys += 1;
              options.events.planKey(key);
            },
          },
        }),
      tell: (event) => told.push(event.kind),
      ended: () => undefined,
    });
    await until(() => keys === 1 && told.includes('connected'));
    await shared.server.close();
    servers.splice(0);
    await until(() => told.includes('hostLeft') || told.includes('ended'));
    expect([told, timers.includes(FIRST_RECONNECT_MILLISECONDS)]).toEqual([
      ['connected', 'hostLeft'],
      false,
    ]);
    session.close();
  });

  it(
    'gets the whole of a plan of several mebibytes once the connection comes back, after it broke in the middle of the transfer',
    { timeout: LARGE_TRANSFER_TIMEOUT_MS },
    async () => {
      const origin = createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID);
      const hostSession = sessionOn(origin, 1);
      const names = drawnNames(LARGE_PLAN_TASKS);
      expect(
        hostSession.applyAll(
          names.map((name, index) => ({
            type: 'putTask' as const,
            task: { ...workTask(`n${String(index).padStart(NAME_DIGITS, '0')}`), name },
          })),
        ).ok,
      ).toBe(true);
      const shared = await startPlanHost(hostSession, { planKey: PLAN_KEY, letEdit: false });
      servers.push(shared.server);
      const network = await relay(() => shared.server.port, CHANNEL_CHUNK_BYTES);
      const guestSession = sessionOn(origin, 2);
      const heard: string[] = [];
      const retries: (() => void)[] = [];
      let session: ReturnType<typeof startGuestSession> | null = null;
      const guest = createGuest({
        session: guestSession,
        send: (message) => {
          session?.send(encodeMessage(message));
        },
        report: () => undefined,
      });
      session = startGuestSession({
        address: LOOPBACK,
        port: network.port,
        secret: { kind: 'code', code: shared.server.code() },
        introduction: LEA,
        startTimer: (milliseconds, onEnd) => {
          if (milliseconds === FIRST_RECONNECT_MILLISECONDS) {
            retries.push(onEnd);
          }
          return () => undefined;
        },
        connect: (options) => connectAsGuest({ ...options, randomBytes: systemRandomBytes }),
        tell: (event) => {
          if (event.kind === 'hostMessage') {
            const message = messageOf(event.message);
            heard.push(message.kind);
            guest.receive(message);
            return;
          }
          heard.push(event.kind);
          if (event.kind === 'connected') {
            guest.connected();
          } else if (event.kind === 'reconnecting') {
            guest.disconnected();
          }
        },
        ended: () => undefined,
      });
      await until(() => heard.includes('reconnecting'));
      expect(guestSession.project().tasks).toHaveLength(1);
      retries.splice(0).forEach((retry) => {
        retry();
      });
      await until(() => guestSession.project().tasks.length === LARGE_PLAN_TASKS + 1);
      expect(guestSession.project()).toEqual(hostSession.project());
      expect(heard).toEqual([
        'connected',
        'participants',
        'reconnecting',
        'connected',
        'participants',
        'update',
        'stateVector',
      ]);
      expect([network.hostBytes() > 2 * CHANNEL_CHUNK_BYTES, shared.refusals]).toEqual([true, []]);
      session.close();
      network.cut();
      await network.close();
    },
  );
});
