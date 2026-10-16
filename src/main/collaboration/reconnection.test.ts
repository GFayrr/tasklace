import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
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
};
const servers: HostServer[] = [];

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

/** Starts a host with the key of the plan on a port, counting who joins. */
async function host(port: number) {
  const joined: string[] = [];
  const started = await startHostServer({
    port,
    planKey: PLAN_KEY,
    startTimer: () => () => undefined,
    randomBytes: systemRandomBytes,
    events: {
      joined: (_peer, introduction) => joined.push(introduction.name),
      message: () => undefined,
      left: () => undefined,
      codeChanged: () => undefined,
    },
  });
  if (!started.ok) {
    throw new Error(started.error);
  }
  servers.push(started.value);
  return { server: started.value, joined };
}

describe('coming back to a host over the network', () => {
  it('joins with the code, then comes back with the key once the host is reachable again', async () => {
    const port = await freePort();
    const first = await host(port);
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
      port,
      code: first.server.code(),
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
    await first.server.close();
    servers.splice(0);
    await until(() => told.includes('reconnecting'));
    const second = await host(port);
    retries.splice(0).forEach((retry) => {
      retry();
    });
    await until(() => second.joined.length === 1);
    expect([told, second.joined]).toEqual([['connected', 'reconnecting', 'connected'], ['Léa']]);
    session.close();
  });
});
