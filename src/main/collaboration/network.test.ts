import { testJoinCode, testPlanKey, testToken } from '../../core/testing/secrets';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { freePort, LOOPBACK, spacedClock, until } from '../testing/plan-host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { requireParticipantId, type ParticipantId } from '../../core/collaboration/participants';
import type { TokenDigest } from '../../core/collaboration/secure/token-digest';
import { WRONG_CODES_BEFORE_NEW_CODE } from '../../core/collaboration/secure/join-code';
import {
  tokenDigestOf,
  type Introduction,
  type JoinSecret,
  type PlanKey,
} from '../../core/collaboration/secure/link';
import {
  MAX_DEPARTED_PARTICIPANTS,
  MAX_OPEN_HANDSHAKES,
  MAX_READ_ONLY_MESSAGE_BYTES,
  MAX_PARTICIPANTS,
} from '../../core/limits';
import { success } from '../../core/result';
import { systemRandomBytes } from './aes-gcm';
import { connectAsGuest, isHostAddress, socketUrlOf, type GuestEnd } from './guest-client';
import { bytesOf, startHostServer, type HostServer, type Peer } from './host-server';
import { MAX_SEALED_FRAME_BYTES } from '../../core/collaboration/secure/channel';
import type { ConnectionEnd, StartTimer } from './secure-connection';

const LEA: Introduction = {
  participantId: requireParticipantId('lea'),
  name: 'Léa',
  token: testToken('ab'.repeat(32)),
  endpoint: { addresses: [], port: 47_313 },
};
const PLAN_KEY = testPlanKey(new Uint8Array(32).fill(7));
const MANY_CONNECTIONS_TIMEOUT_MS = 60_000;
/** Starts no timer, the tests waiting for events instead. */
const noTimer: StartTimer = () => () => undefined;
const servers: HostServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Tells whether nobody listens on a port of every address, by listening on it for a moment. */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(port, '::', () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

/** Finds a free port whose next port is free too, so that a host pushed off the first one surely takes the second. */
async function portBeforeAFreeOne(): Promise<number> {
  for (;;) {
    const port = await freePort();
    if (await isFree(port + 1)) {
      return port;
    }
  }
}

/** Starts a host on a free port, recording everything it tells. */
async function host(
  port?: number,
  planKey: PlanKey | null = null,
  knownTokens: ReadonlyMap<ParticipantId, TokenDigest> = new Map(),
  now: () => number = spacedClock(),
  identity: Introduction | null = null,
) {
  const joined: [Peer, Introduction][] = [];
  const messages: [number, Uint8Array][] = [];
  const left: [number, ConnectionEnd][] = [];
  const codes: string[] = [];
  const started = await startHostServer({
    port: port ?? (await freePort()),
    planKey,
    knownTokens,
    startTimer: noTimer,
    randomBytes: systemRandomBytes,
    now,
    identity,
    events: {
      joined: (peer, introduction) => joined.push([peer, introduction]),
      message: (peer, message) => messages.push([peer.number, message]),
      left: (peer, reason) => left.push([peer.number, reason]),
      codeChanged: (code) => codes.push(code),
    },
  });
  if (!started.ok) {
    throw new Error(started.error);
  }
  servers.push(started.value);
  return { server: started.value, joined, messages, left, codes };
}

/** Joins a host on the loopback address with a code or another secret, recording what the guest is told. */
function guest(port: number, secret: string | JoinSecret, introduction: Introduction = LEA) {
  const messages: Uint8Array[] = [];
  const ends: GuestEnd[] = [];
  const keys: Uint8Array[] = [];
  const identities: (Introduction | null)[] = [];
  let isOpen = false;
  const client = connectAsGuest({
    address: LOOPBACK,
    port,
    secret: typeof secret === 'string' ? { kind: 'code', code: testJoinCode(secret) } : secret,
    introduction,
    startTimer: noTimer,
    randomBytes: systemRandomBytes,
    events: {
      opened: () => {
        isOpen = true;
      },
      message: (message) => messages.push(message),
      planKey: (key) => keys.push(key),
      identity: (host) => identities.push(host),
      ended: (reason) => ends.push(reason),
    },
  });
  return { client, messages, ends, keys, identities, isOpen: () => isOpen };
}

describe('a shared plan over the network', () => {
  it('lets a guest with the code join, exchange messages with the host, and leave', async () => {
    const shared = await host();
    const lea = guest(shared.server.port, shared.server.code());
    await until(() => lea.isOpen() && shared.joined.length === 1);
    expect(shared.joined.map(([peer, introduction]) => [peer.number, introduction])).toEqual([
      [1, LEA],
    ]);
    expect(lea.client.send(Uint8Array.of(1, 2))).toEqual(success(null));
    expect(shared.joined[0]?.[0].send(Uint8Array.of(3))).toEqual(success(null));
    await until(() => shared.messages.length === 1 && lea.messages.length === 1);
    expect([shared.messages, lea.messages]).toEqual([
      [[1, Buffer.from([1, 2])]],
      [Buffer.from([3])],
    ]);
    lea.client.close();
    await until(() => shared.left.length === 1);
    expect([shared.left, lea.ends]).toEqual([[[1, 'WIRE_CLOSED']], ['CLOSED']]);
  });

  it('tells a guest its code is wrong, and the guest whose wrong code was the last one that its code was replaced', async () => {
    const shared = await host();
    const first = shared.server.code();
    const ends: unknown[] = [];
    for (let attempt = 0; attempt < WRONG_CODES_BEFORE_NEW_CODE; attempt += 1) {
      const wrong = guest(shared.server.port, first === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA');
      await until(() => wrong.ends.length === 1);
      ends.push(...wrong.ends);
    }
    expect(ends).toEqual(['WRONG_CODE', 'WRONG_CODE', 'WRONG_CODE', 'WRONG_CODE', 'CODE_REPLACED']);
    expect([shared.codes.length, shared.codes[0] === shared.server.code(), shared.joined]).toEqual([
      1,
      true,
      [],
    ]);
    const late = guest(shared.server.port, first);
    await until(() => late.ends.length === 1);
    expect(late.ends).toEqual(['WRONG_CODE']);
  });

  it('tells who hosts the plan only to a guest allowed to edit, logging any other guest asking', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const hostIdentity = {
      ...LEA,
      participantId: requireParticipantId('camille'),
      name: 'Camille',
    };
    const shared = await host(undefined, null, new Map(), spacedClock(), hostIdentity);
    const lea = guest(shared.server.port, shared.server.code());
    await until(() => lea.isOpen() && shared.joined.length === 1);
    lea.client.askIdentity();
    await until(() => warnings.mock.calls.length === 1);
    shared.joined[0]?.[0].allowEditing();
    lea.client.askIdentity();
    await until(() => lea.identities.length === 1);
    expect([warnings.mock.calls, lea.identities]).toEqual([
      [['A guest not allowed to know who hosts the plan asked for it.']],
      [hostIdentity],
    ]);
  });

  it('takes from a guest only small messages until the host lets it edit', async () => {
    const shared = await host();
    const large = new Uint8Array(MAX_READ_ONLY_MESSAGE_BYTES + 1);
    const reader = guest(shared.server.port, shared.server.code());
    await until(() => reader.isOpen() && shared.joined.length === 1);
    expect(reader.client.send(large)).toEqual(success(null));
    await until(() => shared.left.length === 1);
    const editor = guest(shared.server.port, shared.server.code());
    await until(() => editor.isOpen() && shared.joined.length === 2);
    shared.joined[1]?.[0].allowEditing();
    expect(editor.client.send(large)).toEqual(success(null));
    await until(() => shared.messages.length === 1);
    expect([shared.left, shared.messages.map(([peer, message]) => [peer, message.length])]).toEqual(
      [[[1, 'TOO_LARGE']], [[2, MAX_READ_ONLY_MESSAGE_BYTES + 1]]],
    );
  });

  it('makes an address that typed wrong codes in a row wait before trying again, telling it so', async () => {
    const shared = await host(undefined, null, new Map(), () => 0);
    const wrongCode = shared.server.code() === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    const ends: GuestEnd[] = [];
    for (const secret of [wrongCode, wrongCode, shared.server.code()]) {
      const attempt = guest(shared.server.port, secret);
      await until(() => attempt.ends.length === 1);
      ends.push(...attempt.ends);
    }
    expect(ends).toEqual(['WRONG_CODE', 'WRONG_CODE', 'TRY_LATER']);
  });

  it('does not count against a new code the wrong codes tried against the one it replaced', async () => {
    const shared = await host();
    const first = shared.server.code();
    const wrong = first === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    const together = Array.from({ length: WRONG_CODES_BEFORE_NEW_CODE + 1 }, () =>
      guest(shared.server.port, wrong),
    );
    await until(() => together.every((attempt) => attempt.ends.length === 1));
    const ends = together.flatMap((attempt) => attempt.ends).toSorted();
    const second = shared.server.code();
    const next = second === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    for (let attempt = 0; attempt < WRONG_CODES_BEFORE_NEW_CODE - 1; attempt += 1) {
      const wrongAgain = guest(shared.server.port, next);
      await until(() => wrongAgain.ends.length === 1);
    }
    expect([ends, shared.codes.length]).toEqual([
      ['CODE_REPLACED', 'CODE_REPLACED', 'WRONG_CODE', 'WRONG_CODE', 'WRONG_CODE', 'WRONG_CODE'],
      1,
    ]);
  });

  it('gives each guest the key of the plan, which lets it come back once the code changed, a wrong key not counting as a wrong code', async () => {
    const shared = await host(undefined, PLAN_KEY);
    const lea = guest(shared.server.port, shared.server.code());
    await until(() => lea.keys.length === 1);
    expect(lea.keys).toEqual([Buffer.from(PLAN_KEY)]);
    lea.client.close();
    await until(() => shared.left.length === 1);
    const first = shared.server.code();
    for (let attempt = 0; attempt < WRONG_CODES_BEFORE_NEW_CODE; attempt += 1) {
      const wrong = guest(shared.server.port, first === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA');
      await until(() => wrong.ends.length === 1);
    }
    expect(shared.codes).toHaveLength(1);
    const back = guest(shared.server.port, { kind: 'key', key: PLAN_KEY });
    await until(() => back.isOpen() && shared.joined.length === 2);
    const stranger = guest(
      shared.server.port,
      { kind: 'key', key: testPlanKey(new Uint8Array(32)) },
      { ...LEA, participantId: requireParticipantId('noah') },
    );
    await until(() => stranger.ends.length === 1);
    expect([stranger.ends, shared.codes]).toEqual([['WRONG_KEY'], [shared.server.code()]]);
  });

  it('turns away a guest with the identifier of another person, and lets the same person come back', async () => {
    const shared = await host();
    const lea = guest(shared.server.port, shared.server.code());
    await until(() => lea.isOpen());
    lea.client.close();
    await until(() => shared.left.length === 1);
    const impostor = guest(shared.server.port, shared.server.code(), {
      ...LEA,
      token: testToken('cd'.repeat(32)),
    });
    await until(() => impostor.ends.length === 1);
    expect([impostor.ends, shared.joined.length]).toEqual([['IDENTITY_TAKEN'], 1]);
    const back = guest(shared.server.port, shared.server.code());
    await until(() => back.isOpen() && shared.joined.length === 2);
    expect(shared.joined.map(([, introduction]) => introduction.name)).toEqual(['Léa', 'Léa']);
  });

  it('closes the old connection of a person who comes back before the host saw it end, without refusing that person or changing the key', async () => {
    const shared = await host(undefined, PLAN_KEY);
    const first = guest(shared.server.port, shared.server.code());
    await until(() => first.keys.length === 1);
    const second = guest(shared.server.port, { kind: 'key', key: PLAN_KEY });
    await until(() => second.keys.length === 1 && first.ends.length === 1);
    expect([first.ends, shared.left, shared.joined.map(([peer]) => peer.number)]).toEqual([
      ['WIRE_CLOSED'],
      [[1, 'CLOSED']],
      [1, 2],
    ]);
    second.client.close();
    await until(() => shared.left.length === 2);
    const third = guest(shared.server.port, { kind: 'key', key: PLAN_KEY });
    await until(() => third.keys.length === 1);
    expect([third.ends, Buffer.from(third.keys[0] ?? []).equals(Buffer.from(PLAN_KEY))]).toEqual([
      [],
      true,
    ]);
  });

  it('tells a guest the host turned it away, without refusing the person, who may come back with the code', async () => {
    const shared = await host(undefined, PLAN_KEY);
    const lea = guest(shared.server.port, shared.server.code());
    await until(() => lea.keys.length === 1);
    shared.joined[0]?.[0].turnAway();
    await until(() => lea.ends.length === 1);
    const back = guest(shared.server.port, shared.server.code());
    await until(() => back.keys.length === 1);
    expect([lea.ends, back.ends, shared.codes]).toEqual([['TURNED_AWAY'], [], []]);
  });

  it(
    'refuses any new identifier once it remembers as many tokens as it may, until the host forgets someone who left, never someone connected',
    { timeout: MANY_CONNECTIONS_TIMEOUT_MS },
    async () => {
      const shared = await host();
      for (let index = 0; index < MAX_PARTICIPANTS + MAX_DEPARTED_PARTICIPANTS; index += 1) {
        const someone = guest(shared.server.port, shared.server.code(), {
          ...LEA,
          participantId: requireParticipantId(`p${String(index)}`),
        });
        await until(() => shared.joined.length === index + 1);
        someone.client.close();
      }
      const late = guest(shared.server.port, shared.server.code());
      await until(() => late.ends.length === 1);
      const first = guest(shared.server.port, shared.server.code(), {
        ...LEA,
        participantId: requireParticipantId('p0'),
      });
      await until(
        () =>
          first.isOpen() &&
          shared.joined.length === MAX_PARTICIPANTS + MAX_DEPARTED_PARTICIPANTS + 1,
      );
      expect(late.ends).toEqual(['IDENTITY_TAKEN']);
      first.client.close();
      await until(() => shared.left.length === MAX_PARTICIPANTS + MAX_DEPARTED_PARTICIPANTS + 1);
      shared.server.forget([requireParticipantId('p1'), requireParticipantId('p0')]);
      const newcomer = guest(shared.server.port, shared.server.code());
      await until(() => newcomer.isOpen());
      shared.server.forget([requireParticipantId('lea')]);
      const impostor = guest(shared.server.port, shared.server.code(), {
        ...LEA,
        token: testToken('cd'.repeat(32)),
      });
      await until(() => impostor.ends.length === 1);
      expect(impostor.ends).toEqual(['IDENTITY_TAKEN']);
    },
  );

  it('turns away anyone claiming the identifier of a person whose digest it knows from the previous host, and lets that person in', async () => {
    const shared = await host(
      undefined,
      null,
      new Map([[LEA.participantId, tokenDigestOf(LEA.token)]]),
    );
    const impostor = guest(shared.server.port, shared.server.code(), {
      ...LEA,
      token: testToken('cd'.repeat(32)),
    });
    await until(() => impostor.ends.length === 1);
    const lea = guest(shared.server.port, shared.server.code());
    await until(() => lea.isOpen() && shared.joined.length === 1);
    expect([impostor.ends, shared.joined.map(([, introduction]) => introduction.token)]).toEqual([
      ['IDENTITY_TAKEN'],
      [LEA.token],
    ]);
  });

  it('listens on the next port when the chosen one is taken', async () => {
    const taken = await host(await portBeforeAFreeOne());
    const next = await host(taken.server.port);
    expect(next.server.port).toBe(taken.server.port + 1);
  });

  it('answers a request that is not a WebSocket with an upgrade required', async () => {
    const shared = await host();
    const status = await new Promise<number | undefined>((resolve) => {
      request({ host: LOOPBACK, port: shared.server.port }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).end();
    });
    expect(status).toBe(426);
  });

  it('closes a guest that sends text instead of bytes', async () => {
    const shared = await host();
    const socket = new WebSocket(socketUrlOf(LOOPBACK, shared.server.port));
    const closed = new Promise<void>((resolve) =>
      socket.on('close', () => {
        resolve();
      }),
    );
    socket.on('message', () => {
      socket.send('hello');
    });
    await closed;
    expect(shared.joined).toEqual([]);
  });

  it('turns away a connection beyond the guests still opening theirs', async () => {
    const shared = await host();
    const sockets = Array.from(
      { length: MAX_OPEN_HANDSHAKES + 1 },
      () => new WebSocket(socketUrlOf(LOOPBACK, shared.server.port)),
    );
    const hellos = sockets.map(() => 0);
    const closes = sockets.map(() => false);
    sockets.forEach((socket, index) => {
      socket.on('message', () => {
        hellos[index] = (hellos[index] ?? 0) + 1;
      });
      socket.on('close', () => {
        closes[index] = true;
      });
      socket.on('error', () => undefined);
    });
    await until(
      () =>
        hellos.filter((count) => count === 1).length === MAX_OPEN_HANDSHAKES &&
        closes.some(Boolean),
    );
    expect([hellos.filter((count) => count === 0).length, closes.filter(Boolean).length]).toEqual([
      1, 1,
    ]);
    sockets.forEach((socket) => {
      socket.terminate();
    });
  });

  it('leaves a host that sends text instead of bytes', async () => {
    const port = await freePort();
    const fake = new WebSocketServer({ port, host: LOOPBACK });
    fake.on('connection', (socket) => {
      socket.send('hello');
    });
    const lea = guest(port, 'AAAAAA');
    await until(() => lea.ends.length === 1);
    expect(lea.ends).toEqual(['MALFORMED']);
    await new Promise((resolve) => {
      fake.close(resolve);
    });
  });

  it('tells a guest when nobody answers at the address', async () => {
    const lea = guest(await freePort(), 'AAAAAA');
    await until(() => lea.ends.length === 1);
    expect(lea.ends).toEqual(['UNREACHABLE']);
  });
});

describe('host addresses', () => {
  it('accepts IP addresses and host names, and refuses anything else', () => {
    expect(
      [
        '192.168.1.2',
        'fe80::1%eth0',
        'pc-camille.local',
        'PC1',
        'a b',
        '-pc',
        'pc_1',
        '',
        'x'.repeat(254),
      ].map(isHostAddress),
    ).toEqual([true, true, true, true, false, false, false, false, false]);
  });

  it('writes an IPv6 address in brackets with its zone escaped', () => {
    expect([socketUrlOf('fe80::1%eth0', 47_313), socketUrlOf('pc.local', 1)]).toEqual([
      'ws://[fe80::1%25eth0]:47313',
      'ws://pc.local:1',
    ]);
  });

  it('refuses to join an address that is not one', () => {
    expect(() =>
      connectAsGuest({
        address: 'a b',
        port: 1,
        secret: { kind: 'code', code: testJoinCode('AAAAAA') },
        introduction: LEA,
        startTimer: noTimer,
        randomBytes: systemRandomBytes,
        events: {
          opened: () => undefined,
          message: () => undefined,
          planKey: () => undefined,
          ended: () => undefined,
        },
      }),
    ).toThrow('Not a host address: a b:1');
  });

  it('ends for good, as a fault of the host, a connection whose host sends a frame larger than any the channel makes', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = await freePort();
    const faulty = new WebSocketServer({ host: LOOPBACK, port });
    faulty.on('connection', (socket) => {
      socket.send(new Uint8Array(MAX_SEALED_FRAME_BYTES + 1));
    });
    const lea = guest(port, 'K7Q4MZ');
    await until(() => lea.ends.length === 1);
    await new Promise((resolve) => {
      faulty.close(resolve);
    });
    expect([lea.ends, warnings.mock.calls]).toEqual([
      ['MALFORMED'],
      [['The connection to the shared plan failed: Max payload size exceeded']],
    ]);
  });

  it('closes and logs a guest that sends a frame larger than any the channel makes', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shared = await host();
    const socket = new WebSocket(socketUrlOf(LOOPBACK, shared.server.port));
    const closed = new Promise<number>((resolve) =>
      socket.on('close', (code) => {
        resolve(code);
      }),
    );
    socket.on('open', () => {
      socket.send(new Uint8Array(MAX_SEALED_FRAME_BYTES + 1));
    });
    expect(await closed).toBe(1_009);
    await until(() => warnings.mock.calls.length === 1);
    expect(warnings.mock.calls).toEqual([
      ['A connection to the shared plan failed: Max payload size exceeded'],
    ]);
  });
});

describe('the bytes of a message', () => {
  it('reads one buffer, several and an array buffer', () => {
    expect([
      bytesOf(Buffer.from([1])),
      bytesOf([Buffer.from([1]), Buffer.from([2])]),
      bytesOf(Uint8Array.of(3).buffer),
    ]).toEqual([Buffer.from([1]), Buffer.from([1, 2]), Uint8Array.of(3)]);
  });
});
