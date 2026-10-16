import { request } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { requireParticipantId } from '../../core/collaboration/participants';
import { WRONG_CODES_BEFORE_NEW_CODE } from '../../core/collaboration/secure/join-code';
import type { Introduction } from '../../core/collaboration/secure/link';
import { MAX_OPEN_HANDSHAKES } from '../../core/limits';
import { success } from '../../core/result';
import { systemRandomBytes } from './aes-gcm';
import { connectAsGuest, isHostAddress, socketUrlOf, type GuestEnd } from './guest-client';
import { bytesOf, startHostServer, type HostServer, type Peer } from './host-server';
import { MAX_SEALED_FRAME_BYTES } from '../../core/collaboration/secure/channel';
import type { ConnectionEnd, StartTimer } from './secure-connection';

const LEA: Introduction = { participantId: requireParticipantId('lea'), name: 'Léa' };
const LOOPBACK = '127.0.0.1';
/** Starts no timer, the tests waiting for events instead. */
const noTimer: StartTimer = () => () => undefined;
const servers: HostServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Finds a port nobody listens on, by letting the system choose one and freeing it. */
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

/** Waits until a condition holds, checking at each turn of the event loop. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Starts a host on a free port, recording everything it tells. */
async function host(port?: number) {
  const joined: [Peer, Introduction][] = [];
  const messages: [number, Uint8Array][] = [];
  const left: [number, ConnectionEnd][] = [];
  const codes: string[] = [];
  const started = await startHostServer({
    port: port ?? (await freePort()),
    startTimer: noTimer,
    randomBytes: systemRandomBytes,
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

/** Joins a host on the loopback address, recording what the guest is told. */
function guest(port: number, code: string) {
  const messages: Uint8Array[] = [];
  const ends: GuestEnd[] = [];
  let isOpen = false;
  const client = connectAsGuest({
    address: LOOPBACK,
    port,
    code,
    introduction: LEA,
    startTimer: noTimer,
    randomBytes: systemRandomBytes,
    events: {
      opened: () => {
        isOpen = true;
      },
      message: (message) => messages.push(message),
      ended: (reason) => ends.push(reason),
    },
  });
  return { client, messages, ends, isOpen: () => isOpen };
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

  it('listens on the next port when the chosen one is taken', async () => {
    const taken = await host();
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
        code: 'AAAAAA',
        introduction: LEA,
        startTimer: noTimer,
        randomBytes: systemRandomBytes,
        events: { opened: () => undefined, message: () => undefined, ended: () => undefined },
      }),
    ).toThrow('Not a host address: a b:1');
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
