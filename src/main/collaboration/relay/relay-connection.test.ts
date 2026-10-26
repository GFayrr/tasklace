import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { startRelayServer, type RunningRelay } from '../../../../relay/src/server.ts';
import { testConfig } from '../../../../relay/src/testing/relay-client.ts';
import { sealedRecord, temporaryFolder } from '../../../../relay/src/testing/relay-records.ts';
import type { RelayCrypto, RelayMessage } from '../../../core/collaboration/relay/relay-envelope';
import {
  drawRelayAccess,
  relayKeysOf,
  viewAccessOf,
  type RelayKeys,
} from '../../../core/collaboration/relay/relay-keys';
import type { RelayAddress } from '../../../core/collaboration/relay/relay-link';
import {
  encodeRelayFrame,
  RELAY_WIRE_VERSION,
  type RelayFrame,
} from '../../../core/collaboration/relay/relay-wire';
import { seededRandom } from '../../../core/testing/test-crypto';
import { aesGcm, systemRandomBytes } from '../aes-gcm';
import { zlibCompressor } from '../../zlib-compressor';
import { freePort, LOOPBACK, until } from '../../testing/plan-host';
import type { StartTimer } from '../secure-connection';
import {
  endOfError,
  startRelaySession,
  type RelaySession,
  type RelaySessionEvent,
} from './relay-connection';

const SPEED_UP = 64;
const ONE_MEBIBYTE = 1_048_576;
const CRYPTO: RelayCrypto = {
  aead: aesGcm,
  compression: zlibCompressor,
  randomBytes: systemRandomBytes,
};
const ACCESS = drawRelayAccess(seededRandom(41));
const EDIT_KEYS = relayKeysOf(ACCESS);
const VIEW_KEYS = relayKeysOf(viewAccessOf(ACCESS));
const OTHER_KEYS = relayKeysOf(drawRelayAccess(seededRandom(42)));

let folder: string;
let removeFolder: () => Promise<void>;
const relays: RunningRelay[] = [];
const sessions: RelaySession[] = [];
const fakes: WebSocketServer[] = [];

beforeEach(async () => {
  ({ folder, remove: removeFolder } = await temporaryFolder());
});

afterEach(async () => {
  sessions.splice(0).forEach((session) => {
    session.close();
  });
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
  await Promise.all(
    fakes.splice(0).map(
      (fake) =>
        new Promise((resolve) => {
          fake.close(resolve);
        }),
    ),
  );
  vi.restoreAllMocks();
  await removeFolder();
});

/** Runs the waits of a session sixty-four times faster, so that coming back and going offline take a moment. */
const fastTimer: StartTimer = (milliseconds, onEnd) => {
  const timer = setTimeout(onEnd, milliseconds / SPEED_UP);
  return () => {
    clearTimeout(timer);
  };
};

/** Starts a real relay on a port of this computer, keeping its rooms in the folder of the test. */
async function startedRelay(
  port = 0,
  environment: Record<string, string> = {},
): Promise<RunningRelay> {
  const relay = await startRelayServer({
    config: testConfig(folder, { RELAY_PORT: String(port), ...environment }),
  });
  relays.push(relay);
  return relay;
}

/** Gives the address of a relay listening on a port of this computer. */
function addressOf(port: number): RelayAddress {
  return { host: '127.0.0.1', port, path: '/' };
}

/** Starts a session in a room of a relay, recording what it tells. */
function joinRelay(
  port: number,
  keys: RelayKeys,
  options: { readonly creates?: boolean; readonly keepTrying?: boolean } = {},
) {
  const events: RelaySessionEvent[] = [];
  const session = startRelaySession({
    address: addressOf(port),
    keys,
    creates: options.creates ?? false,
    keepTrying: options.keepTrying ?? false,
    crypto: CRYPTO,
    startTimer: fastTimer,
    tell: (event) => events.push(event),
  });
  sessions.push(session);
  return { session, events, kinds: () => events.map((event) => event.kind) };
}

/** Gives a change of the plan to send, filled with one byte. */
function update(byte: number, length = 8): RelayMessage {
  return {
    kind: 'update',
    messageId: new Uint8Array(16).fill(byte),
    covers: 0,
    bytes: new Uint8Array(length).fill(byte),
  };
}

/** Gives what the page sees of the messages a session handed it: their kind, first byte, length and the sequence settled. */
function deliveriesOf(events: readonly RelaySessionEvent[]) {
  return events.flatMap((event) =>
    event.kind === 'delivery'
      ? [
          {
            kind: event.delivery.kind,
            byte: event.delivery.bytes[0],
            length: event.delivery.bytes.length,
            settled: event.delivery.settled,
          },
        ]
      : [],
  );
}

/** Gives an event with the bytes of its presence as a plain list, whatever kind of bytes held them. */
function plainPresence(event: RelaySessionEvent) {
  return event.kind === 'presence'
    ? { ...event, presence: { ...event.presence, bytes: [...event.presence.bytes] } }
    : event;
}

/** Starts a relay of its own that sends each member who connects the frames a test gives, as a relay that lies would. */
async function lyingRelay(frames: readonly (Uint8Array | string)[]): Promise<number> {
  const port = await freePort();
  const fake = new WebSocketServer({ host: LOOPBACK, port });
  fakes.push(fake);
  fake.on('connection', (socket: WebSocket) => {
    socket.once('message', () => {
      frames.forEach((frame) => {
        socket.send(frame);
      });
    });
  });
  await new Promise((resolve) => fake.once('listening', resolve));
  return port;
}

const WELCOME: RelayFrame = {
  type: 'welcome',
  member: 1,
  verifyKey: EDIT_KEYS.verifyKey,
  members: [],
};

describe('a session in a room of a relay', () => {
  it('creates the room, gets in alone and gets each change it sends back once kept', async () => {
    const relay = await startedRelay();
    const editor = joinRelay(relay.port, EDIT_KEYS, { creates: true });
    await until(() => editor.kinds().includes('connected'));
    expect(editor.session.send({ kind: 'message', message: update(7) })).toEqual({
      ok: true,
      value: undefined,
    });
    await until(() => editor.kinds().includes('delivery'));
    expect([editor.events[0], deliveriesOf(editor.events)]).toEqual([
      { kind: 'connected', member: 1, members: [] },
      [{ kind: 'update', byte: 7, length: 8, settled: 1 }],
    ]);
  });

  it('hands a message cut into chunks once all its chunks are in', async () => {
    const relay = await startedRelay();
    const editor = joinRelay(relay.port, EDIT_KEYS, { creates: true });
    await until(() => editor.kinds().includes('connected'));
    const noise = systemRandomBytes(ONE_MEBIBYTE * 1.5);
    editor.session.send({ kind: 'message', message: { ...update(8), bytes: noise } });
    await until(() => editor.kinds().includes('delivery'));
    const delivered = editor.events.find((event) => event.kind === 'delivery');
    expect([
      deliveriesOf(editor.events).map(({ length, settled }) => ({ length, settled })),
      delivered?.kind === 'delivery' && Buffer.from(delivered.delivery.bytes).equals(noise),
    ]).toEqual([[{ length: ONE_MEBIBYTE * 1.5, settled: 2 }], true]);
  });

  it('lets a member with the link that reads in, catching it up, passing presence both ways and telling who comes and goes', async () => {
    const relay = await startedRelay();
    const editor = joinRelay(relay.port, EDIT_KEYS, { creates: true });
    await until(() => editor.kinds().includes('connected'));
    editor.session.send({ kind: 'message', message: update(3) });
    await until(() => editor.kinds().includes('delivery'));
    const viewer = joinRelay(relay.port, VIEW_KEYS);
    await until(() => viewer.kinds().includes('caughtUp'));
    editor.session.send({ kind: 'presence', bytes: Uint8Array.of(1, 2) });
    viewer.session.send({ kind: 'presence', bytes: Uint8Array.of(9) });
    await until(() => viewer.kinds().includes('presence') && editor.kinds().includes('presence'));
    viewer.session.close();
    await until(() => editor.kinds().includes('left'));
    expect([
      viewer.events.slice(0, 3),
      viewer.events.filter((event) => event.kind === 'presence').map(plainPresence),
      editor.events
        .filter((event) => ['joined', 'left', 'presence'].includes(event.kind))
        .map(plainPresence),
    ]).toEqual([
      [
        { kind: 'connected', member: 2, members: [1] },
        expect.objectContaining({ kind: 'delivery' }),
        { kind: 'caughtUp' },
      ],
      [{ kind: 'presence', member: 1, presence: { bytes: [1, 2], canEdit: true } }],
      [
        { kind: 'joined', member: 2 },
        { kind: 'presence', member: 2, presence: { bytes: [9], canEdit: false } },
        { kind: 'left', member: 2 },
      ],
    ]);
  });

  it('refuses to send before it is in, a change from the link that reads, and closing the room without the link that edits', async () => {
    const relay = await startedRelay();
    const editor = joinRelay(relay.port, EDIT_KEYS, { creates: true });
    const early = editor.session.send({ kind: 'message', message: update(1) });
    const earlyClose = editor.session.closeRoom();
    await until(() => editor.kinds().includes('connected'));
    const viewer = joinRelay(relay.port, VIEW_KEYS);
    await until(() => viewer.kinds().includes('caughtUp'));
    expect([
      early,
      earlyClose,
      viewer.session.send({ kind: 'message', message: update(2) }),
      viewer.session.closeRoom(),
      viewer.session.send({ kind: 'presence', bytes: new Uint8Array(8_192) }),
    ]).toEqual([
      { ok: false, error: 'NOT_OPEN' },
      { ok: false, error: 'NOT_OPEN' },
      { ok: false, error: 'READ_ONLY' },
      { ok: false, error: 'READ_ONLY' },
      { ok: false, error: 'TOO_LARGE' },
    ]);
  });

  it('closes the room for good with the link that edits, telling every member', async () => {
    const relay = await startedRelay();
    const editor = joinRelay(relay.port, EDIT_KEYS, { creates: true });
    await until(() => editor.kinds().includes('connected'));
    const viewer = joinRelay(relay.port, VIEW_KEYS);
    await until(() => viewer.kinds().includes('caughtUp'));
    expect(editor.session.closeRoom()).toEqual({ ok: true, value: undefined });
    await until(() => editor.kinds().includes('ended') && viewer.kinds().includes('ended'));
    const comingBack = joinRelay(relay.port, VIEW_KEYS);
    await until(() => comingBack.kinds().includes('ended'));
    expect([editor.events.at(-1), viewer.events.at(-1), comingBack.events]).toEqual([
      { kind: 'ended', reason: 'CLOSED' },
      { kind: 'ended', reason: 'CLOSED' },
      [{ kind: 'ended', reason: 'NO_ROOM' }],
    ]);
  });

  it('ends at once when the relay cannot be reached before it was ever in, unless the window keeps trying, which gets in once the relay is up', async () => {
    const port = await freePort();
    const joining = joinRelay(port, EDIT_KEYS);
    const reopening = joinRelay(port, EDIT_KEYS, { keepTrying: true });
    const creating = joinRelay(port, EDIT_KEYS, { creates: true });
    await until(() => joining.kinds().includes('ended') && creating.kinds().includes('ended'));
    await until(() => reopening.kinds().includes('offline'));
    await startedRelay(port);
    await until(() => reopening.kinds().includes('ended'));
    expect([joining.events, creating.events, reopening.kinds()]).toEqual([
      [{ kind: 'ended', reason: 'UNREACHABLE' }],
      [{ kind: 'ended', reason: 'UNREACHABLE' }],
      ['reconnecting', 'offline', 'ended'],
    ]);
    expect(reopening.events.at(-1)).toEqual({ kind: 'ended', reason: 'NO_ROOM' });
  });

  it('comes back after the relay restarts, from the last record it has, receiving only what it missed', async () => {
    const port = await freePort();
    const first = await startedRelay(port);
    const editor = joinRelay(port, EDIT_KEYS, { creates: true });
    await until(() => editor.kinds().includes('connected'));
    editor.session.send({ kind: 'message', message: update(4) });
    await until(() => deliveriesOf(editor.events).length === 1);
    await first.close();
    relays.splice(relays.indexOf(first), 1);
    await until(() => editor.kinds().includes('reconnecting'));
    await startedRelay(port);
    await until(() => editor.kinds().filter((kind) => kind === 'connected').length === 2);
    editor.session.send({ kind: 'message', message: update(5) });
    await until(() => deliveriesOf(editor.events).length === 2);
    expect([editor.kinds().slice(0, 6), deliveriesOf(editor.events)]).toEqual([
      ['connected', 'caughtUp', 'delivery', 'reconnecting', 'connected', 'caughtUp'],
      [
        { kind: 'update', byte: 4, length: 8, settled: 1 },
        { kind: 'update', byte: 5, length: 8, settled: 2 },
      ],
    ]);
  });

  it('ends for good when the relay refuses a change too large for the room', async () => {
    const relay = await startedRelay(0, { RELAY_MAX_ROOM_BYTES: String(ONE_MEBIBYTE) });
    const editor = joinRelay(relay.port, EDIT_KEYS, { creates: true });
    await until(() => editor.kinds().includes('connected'));
    const noise = systemRandomBytes(ONE_MEBIBYTE * 1.5);
    editor.session.send({ kind: 'message', message: { ...update(6), bytes: noise } });
    await until(() => editor.kinds().includes('ended'));
    expect(editor.events.at(-1)).toEqual({ kind: 'ended', reason: 'TOO_LARGE' });
  });

  it('sends nothing more and tells nothing once the window leaves', async () => {
    const relay = await startedRelay();
    const editor = joinRelay(relay.port, EDIT_KEYS, { creates: true });
    await until(() => editor.kinds().includes('connected'));
    editor.session.close();
    const told = editor.events.length;
    await relay.close();
    relays.splice(0);
    expect([
      editor.session.send({ kind: 'message', message: update(1) }),
      editor.events.length,
    ]).toEqual([{ ok: false, error: 'NOT_OPEN' }, told]);
  });
});

describe('a session with a relay that lies', () => {
  it('sets aside a record or a presence that does not open, and a record it already has', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = await lyingRelay([
      encodeRelayFrame(WELCOME),
      encodeRelayFrame({ type: 'record', seq: 3, record: sealedRecord('update', 1) }),
      encodeRelayFrame({ type: 'record', seq: 2, record: sealedRecord('update', 2) }),
      encodeRelayFrame({ type: 'presence', member: 2, bytes: new Uint8Array(100) }),
      encodeRelayFrame({ type: 'caughtUp' }),
    ]);
    const member = joinRelay(port, OTHER_KEYS);
    await until(() => member.kinds().includes('caughtUp'));
    expect([member.kinds(), warn.mock.calls]).toEqual([
      ['connected', 'caughtUp'],
      [
        ['A record of the shared plan was set aside: BAD_SIGNATURE.'],
        ['A presence in the shared plan did not open and was set aside.'],
      ],
    ]);
  });

  it.each([
    ['text', 'hello', 'MALFORMED'],
    ['bytes that are not a frame', Uint8Array.of(RELAY_WIRE_VERSION, 99), 'MALFORMED'],
    [
      'another version of the format',
      Uint8Array.of(RELAY_WIRE_VERSION + 1, 1),
      'UNSUPPORTED_VERSION',
    ],
  ] as const)('ends for good on %s, even once it was in', async (_name, frame, reason) => {
    const port = await lyingRelay([encodeRelayFrame(WELCOME), frame]);
    const member = joinRelay(port, OTHER_KEYS, { keepTrying: true });
    await until(() => member.kinds().includes('ended'));
    expect(member.events).toEqual([
      { kind: 'connected', member: 1, members: [] },
      { kind: 'ended', reason },
    ]);
  });

  it('tells nothing more once a refusal ended it, even what the relay sent after', async () => {
    const port = await lyingRelay([
      encodeRelayFrame(WELCOME),
      encodeRelayFrame({ type: 'refused', reason: 'NO_ROOM' }),
      encodeRelayFrame({ type: 'caughtUp' }),
      encodeRelayFrame({ type: 'joined', member: 2 }),
    ]);
    const member = joinRelay(port, OTHER_KEYS);
    await until(() => member.kinds().includes('ended'));
    await new Promise((resolve) => setTimeout(resolve, 64));
    expect(member.events).toEqual([
      { kind: 'connected', member: 1, members: [] },
      { kind: 'ended', reason: 'NO_ROOM' },
    ]);
  });

  it('tries again after a refusal that may pass, once it was in', async () => {
    const port = await lyingRelay([
      encodeRelayFrame(WELCOME),
      encodeRelayFrame({ type: 'refused', reason: 'TOO_FAST' }),
    ]);
    const member = joinRelay(port, OTHER_KEYS);
    await until(() => member.kinds().filter((kind) => kind === 'connected').length === 2);
    expect(member.kinds().slice(0, 3)).toEqual(['connected', 'reconnecting', 'connected']);
  });
});

describe('a session that creates a room', () => {
  it('needs the link that edits, which alone can sign the creation', () => {
    expect(() =>
      startRelaySession({
        address: addressOf(1),
        keys: VIEW_KEYS,
        creates: true,
        keepTrying: false,
        crypto: CRYPTO,
        startTimer: fastTimer,
        tell: () => undefined,
      }),
    ).toThrow('Only the link that edits a plan can create its room.');
  });
});

describe('the reason a socket to the relay failed', () => {
  it.each([
    ['a certificate this computer does not trust', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNTRUSTED'],
    ['a certificate for another name', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNTRUSTED'],
    ['a broken protocol', 'WS_ERR_INVALID_OPCODE', 'MALFORMED'],
    ['a network that does not reach it', 'ECONNREFUSED', 'UNREACHABLE'],
    ['an error without a code', undefined, 'UNREACHABLE'],
  ])('is told for %s', (_name, code, reason) => {
    expect(endOfError(Object.assign(new Error('failed'), { code }))).toBe(reason);
  });
});
