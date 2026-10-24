import { testToken } from '../../core/testing/secrets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { requireParticipantId } from '../../core/collaboration/participants';
import type { Introduction } from '../../core/collaboration/secure/link';
import { freePort, LOOPBACK, spacedClock, until } from '../testing/plan-host';
import { systemRandomBytes } from './aes-gcm';
import { connectAsGuest, socketUrlOf } from './guest-client';
import { startHostServer, type HostServer } from './host-server';
import type { StartTimer } from './secure-connection';

vi.mock('../../core/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/limits')>()),
  MAX_PARTICIPANTS: 0,
  MAX_OPEN_HANDSHAKES: 2,
}));

/** Starts no timer, the test waiting for events instead. */
const noTimer: StartTimer = () => () => undefined;
const servers: HostServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Builds who a guest of the test is. */
function person(id: string): Introduction {
  return {
    participantId: requireParticipantId(id),
    name: id,
    token: testToken(id.padEnd(64, '0')),
    endpoint: { addresses: [], port: 47_313 },
  };
}

describe('a host holding as many connections as it allows', () => {
  it('cuts any further connection before it says a word', async () => {
    const joined: string[] = [];
    const started = await startHostServer({
      port: await freePort(),
      planKey: null,
      knownTokens: new Map(),
      startTimer: noTimer,
      randomBytes: systemRandomBytes,
      now: spacedClock(),
      identity: null,
      events: {
        joined: (_peer, introduction) => joined.push(introduction.participantId),
        message: () => undefined,
        left: () => undefined,
        codeChanged: () => undefined,
      },
    });
    if (!started.ok) {
      throw new Error(started.error);
    }
    servers.push(started.value);
    for (const id of ['a', 'b']) {
      connectAsGuest({
        address: LOOPBACK,
        port: started.value.port,
        secret: { kind: 'code', code: started.value.code() },
        introduction: person(id),
        startTimer: noTimer,
        randomBytes: systemRandomBytes,
        events: {
          opened: () => undefined,
          message: () => undefined,
          planKey: () => undefined,
          ended: () => undefined,
        },
      });
    }
    await until(() => joined.length === 2);
    const extra = new WebSocket(socketUrlOf(LOOPBACK, started.value.port));
    let said = 0;
    let isClosed = false;
    extra.on('message', () => {
      said += 1;
    });
    extra.on('close', () => {
      isClosed = true;
    });
    extra.on('error', () => undefined);
    await until(() => isClosed);
    expect([joined, said]).toEqual([['a', 'b'], 0]);
  });
});
