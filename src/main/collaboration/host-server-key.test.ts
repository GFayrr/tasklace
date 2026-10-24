import { testToken } from '../../core/testing/secrets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireParticipantId } from '../../core/collaboration/participants';
import type { Introduction } from '../../core/collaboration/secure/link';
import { failure } from '../../core/result';
import { freePort, LOOPBACK, spacedClock, until } from '../testing/plan-host';
import { systemRandomBytes } from './aes-gcm';
import { connectAsGuest, type GuestEnd } from './guest-client';
import { startHostServer, type HostServer } from './host-server';
import type { ConnectionEnd, StartTimer } from './secure-connection';

vi.mock('./secure-connection', async (importOriginal) => {
  const original = await importOriginal<typeof import('./secure-connection')>();
  return {
    ...original,
    acceptGuest: (options: Parameters<typeof original.acceptGuest>[0]) => ({
      ...original.acceptGuest(options),
      sendPlanKey: () => failure('TOO_LARGE'),
    }),
  };
});

const LEA: Introduction = {
  participantId: requireParticipantId('lea'),
  name: 'Léa',
  token: testToken('ab'.repeat(32)),
  endpoint: { addresses: [], port: 47_313 },
};
/** Starts no timer, the test waiting for events instead. */
const noTimer: StartTimer = () => () => undefined;
const servers: HostServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('a host that cannot give the key of the plan', () => {
  it('closes the connection of the guest it admitted before telling the page, logging why', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const joined: Introduction[] = [];
    const left: ConnectionEnd[] = [];
    const started = await startHostServer({
      port: await freePort(),
      planKey: null,
      knownTokens: new Map(),
      startTimer: noTimer,
      randomBytes: systemRandomBytes,
      now: spacedClock(),
      identity: null,
      events: {
        joined: (_peer, introduction) => joined.push(introduction),
        message: () => undefined,
        left: (_peer, reason) => left.push(reason),
        codeChanged: () => undefined,
      },
    });
    if (!started.ok) {
      throw new Error(started.error);
    }
    servers.push(started.value);
    const ends: GuestEnd[] = [];
    const keys: Uint8Array[] = [];
    connectAsGuest({
      address: LOOPBACK,
      port: started.value.port,
      secret: { kind: 'code', code: started.value.code() },
      introduction: LEA,
      startTimer: noTimer,
      randomBytes: systemRandomBytes,
      events: {
        opened: () => undefined,
        message: () => undefined,
        planKey: (key) => keys.push(key),
        ended: (reason) => ends.push(reason),
      },
    });
    await until(() => ends.length === 1);
    expect([warned.mock.calls, joined, left, ends, keys]).toEqual([
      [['The key of the shared plan could not be sent: TOO_LARGE.']],
      [],
      [],
      ['WIRE_CLOSED'],
      [],
    ]);
  });
});
