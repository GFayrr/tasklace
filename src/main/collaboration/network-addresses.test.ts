import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireParticipantId } from '../../core/collaboration/participants';
import { systemRandomBytes } from './aes-gcm';
import { connectAsGuest, type GuestEnd } from './guest-client';
import { startHostServer, type HostServer } from './host-server';

const privacy = vi.hoisted(() => ({ answers: [] as boolean[] }));

vi.mock('./private-addresses', () => ({
  isPrivateAddress: () => privacy.answers.shift() ?? false,
}));

const LOOPBACK = '127.0.0.1';
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

/** Starts a host, then a guest, and waits for how the guest ends. */
async function joinWith(answers: boolean[]): Promise<{ ends: GuestEnd[]; joined: number }> {
  let joined = 0;
  const started = await startHostServer({
    port: await freePort(),
    planKey: null,
    knownTokens: new Map(),
    startTimer: () => () => undefined,
    randomBytes: systemRandomBytes,
    events: {
      joined: () => {
        joined += 1;
      },
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
  privacy.answers = answers;
  const ends: GuestEnd[] = [];
  connectAsGuest({
    address: LOOPBACK,
    port: started.value.port,
    secret: { kind: 'code', code: started.value.code() },
    introduction: {
      participantId: requireParticipantId('lea'),
      name: 'Léa',
      token: 'ab'.repeat(32),
      endpoint: { addresses: [], port: 47_313 },
    },
    startTimer: () => () => undefined,
    randomBytes: systemRandomBytes,
    events: {
      opened: () => undefined,
      message: () => undefined,
      planKey: () => undefined,
      ended: (reason) => ends.push(reason),
    },
  });
  while (ends.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { ends, joined };
}

describe('connections from and to addresses outside the private networks', () => {
  it('lets the host drop a connection from such an address before anything is sent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await joinWith([false])).toEqual({ ends: ['UNREACHABLE'], joined: 0 });
  });

  it('lets the guest leave a host that answers from such an address, before telling it anything', async () => {
    expect(await joinWith([true, false])).toEqual({ ends: ['NOT_PRIVATE'], joined: 0 });
  });
});
