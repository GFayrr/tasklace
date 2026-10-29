import { testPlanKey, testToken } from '../../core/testing/secrets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeMessage } from '../../core/collaboration/messages';
import { createGuest } from '../../core/collaboration/sync';
import { CHANNEL_CHUNK_BYTES, HEARTBEAT_MILLISECONDS } from '../../core/limits';
import { success } from '../../core/result';
import { createSharedDocument } from '../../core/shared/shared-document';
import { project, TEST_DOCUMENT_ID, workTask } from '../../core/testing/project-builder';
import { sessionOn } from '../../core/testing/session-copy';
import {
  freePort,
  LOOPBACK,
  messageOf,
  spacedClock,
  startPlanHost,
  until,
} from '../testing/plan-host';
import { requireParticipantId } from '../../core/collaboration/participants';
import { FIRST_RECONNECT_MILLISECONDS } from '../../core/collaboration/reconnection';
import type { Introduction } from '../../core/collaboration/secure/link';
import type { CollaborationEvent } from '../../preload/bridge-contract';
import { systemRandomBytes } from './aes-gcm';
import { connectAsGuest } from './guest-client';
import { startGuestSession } from './guest-session';
import { startHostServer, type HostServer, type Peer } from './host-server';
import type { StartTimer } from './secure-connection';
import { drawnNames, startTcpRelay } from '../testing/tcp-relay';

const PLAN_KEY = testPlanKey(new Uint8Array(32).fill(3));
const LEA: Introduction = {
  participantId: requireParticipantId('lea'),
  name: 'Léa',
  token: testToken('ab'.repeat(32)),
  endpoint: { addresses: [], port: 47_313 },
};
const servers: HostServer[] = [];
const LARGE_PLAN_TASKS = 8_000;
const LARGE_TRANSFER_TIMEOUT_MS = 60_000;
const NAME_DIGITS = 4;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Starts a host with the key of the plan on a port, counting who joins. */
async function host(port: number, startTimer: StartTimer = () => () => undefined) {
  const joined: string[] = [];
  const left: string[] = [];
  const peers: Peer[] = [];
  const started = await startHostServer({
    port,
    planKey: PLAN_KEY,
    knownDigests: new Map(),
    startTimer,
    randomBytes: systemRandomBytes,
    identity: null,
    now: spacedClock(),
    events: {
      joined: (peer, introduction) => {
        peers.push(peer);
        joined.push(introduction.name);
      },
      message: () => undefined,
      left: (_peer, reason) => left.push(reason),
      codeChanged: () => undefined,
    },
  });
  if (!started.ok) {
    throw new Error(started.error);
  }
  servers.push(started.value);
  return { server: started.value, joined, left, peers };
}

describe('coming back to a host over the network', () => {
  it('joins with the code, then comes back with the key once the network lets it reach the host again', async () => {
    const first = await host(await freePort());
    let target = first.server.port;
    const network = await startTcpRelay(() => target);
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

  it('breaks a connection whose bytes were changed on the way, passing nothing on, and comes back with the key, the host closing the broken connection', async () => {
    const shared = await host(await freePort());
    const network = await startTcpRelay(() => shared.server.port);
    const told: CollaborationEvent['kind'][] = [];
    const messages: Uint8Array[] = [];
    const retries: (() => void)[] = [];
    let keys = 0;
    const session = startGuestSession({
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
      connect: (options) =>
        connectAsGuest({
          ...options,
          randomBytes: systemRandomBytes,
          events: {
            ...options.events,
            message: (message) => messages.push(message),
            planKey: (key) => {
              keys += 1;
              options.events.planKey(key);
            },
          },
        }),
      tell: (event) => told.push(event.kind),
      ended: () => undefined,
    });
    await until(() => keys === 1 && shared.joined.length === 1);
    network.tamper();
    expect(shared.peers[0]?.send(Uint8Array.of(1, 2, 3))).toEqual(success(null));
    await until(() => told.includes('reconnecting'));
    retries.splice(0).forEach((retry) => {
      retry();
    });
    await until(() => shared.joined.length === 2 && shared.left.length === 1);
    expect([told, messages, shared.left, shared.joined]).toEqual([
      ['connected', 'reconnecting', 'connected'],
      [],
      ['CLOSED'],
      ['Léa', 'Léa'],
    ]);
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
      const network = await startTcpRelay(() => shared.server.port, {
        afterTargetBytes: CHANNEL_CHUNK_BYTES,
      });
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
      expect([network.targetBytes() > 2 * CHANNEL_CHUNK_BYTES, shared.refusals]).toEqual([
        true,
        [],
      ]);
      session.close();
      network.cut();
      await network.close();
    },
  );

  it('cuts the connection once the other end goes silent without closing it, as when its computer is switched off, on both sides', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const beats: (() => void)[] = [];
    /** Keeps the beats of the heartbeat and its last look before cutting for the test to fire, and starts no other timer. */
    const startTimer: StartTimer = (milliseconds, onEnd) => {
      if (milliseconds === HEARTBEAT_MILLISECONDS || milliseconds === 0) {
        beats.push(onEnd);
      }
      return () => undefined;
    };
    /** Fires every beat waiting, as when the time between two pings went by. */
    const beat = (): void => {
      beats.splice(0).forEach((onEnd) => {
        onEnd();
      });
    };
    const shared = await host(await freePort(), startTimer);
    const network = await startTcpRelay(() => shared.server.port);
    const told: CollaborationEvent['kind'][] = [];
    let keys = 0;
    const session = startGuestSession({
      address: LOOPBACK,
      port: network.port,
      secret: { kind: 'code', code: shared.server.code() },
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
    await until(() => keys === 1 && shared.joined.length === 1 && beats.length === 2);
    network.freeze();
    beat();
    beat();
    beat();
    beat();
    await until(() => told.includes('reconnecting') && shared.left.length === 1);
    expect([told, shared.left]).toEqual([['connected', 'reconnecting'], ['WIRE_CLOSED']]);
    expect(warnings.mock.calls.filter(([text]) => String(text).includes('stayed silent'))).toEqual([
      ['A connection to the shared plan stayed silent and was cut.'],
      ['A connection to the shared plan stayed silent and was cut.'],
    ]);
    session.close();
    network.cut();
    await network.close();
  });
});
