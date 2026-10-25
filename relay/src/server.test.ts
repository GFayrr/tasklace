import { stat } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeClientFrame } from '../../src/core/collaboration/relay/relay-wire.ts';
import {
  startRelayServer,
  type RelayServerOptions,
  type RelayTimings,
  type RunningRelay,
} from './server.ts';
import {
  closeFrame,
  connectTo,
  createFrame,
  testConfig,
  type TestClient,
} from './testing/relay-client.ts';
import { OTHER_KEYS, ROOM_KEYS, sealedRecord, temporaryFolder } from './testing/relay-records.ts';

const CLOSE_REFUSED = 1008;
const CLOSE_NORMAL = 1000;
const CLOSE_ABNORMAL = 1006;
const FAST: RelayTimings = {
  helloMilliseconds: 8_192,
  heartbeatMilliseconds: 16_384,
  sweepMilliseconds: 3_600_000,
  closeMilliseconds: 256,
};

let folder: string;
let removeFolder: () => Promise<void>;
const running: RunningRelay[] = [];

beforeEach(async () => {
  ({ folder, remove: removeFolder } = await temporaryFolder());
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((relay) => relay.close()));
  vi.restoreAllMocks();
  await removeFolder();
});

/** Starts a relay for the test, with settings changed from the defaults. */
async function relayWith(
  environment: Record<string, string> = {},
  options: Partial<RelayServerOptions> = {},
): Promise<RunningRelay> {
  const relay = await startRelayServer({
    config: testConfig(folder, environment),
    timings: FAST,
    ...options,
  });
  running.push(relay);
  return relay;
}

/** Connects a member that creates the room of the test keys, past its welcome and catching up. */
async function creator(relay: RunningRelay): Promise<TestClient> {
  const client = await connectTo(relay.port);
  client.send(createFrame(ROOM_KEYS));
  await client.next();
  await client.next();
  return client;
}

/** Connects a member that opens the room of the test keys after a sequence it already has. */
async function opener(relay: RunningRelay, since = 0): Promise<TestClient> {
  const client = await connectTo(relay.port);
  client.send({ type: 'hello', roomId: ROOM_KEYS.roomId, since });
  return client;
}

describe('a relay', () => {
  it('lets the member who creates a room in, alone, the room holding nothing yet', async () => {
    const relay = await relayWith();
    const client = await connectTo(relay.port);
    client.send(createFrame(ROOM_KEYS));
    expect([await client.next(), await client.next()]).toEqual([
      { type: 'welcome', member: 1, verifyKey: ROOM_KEYS.verifyKey, members: [] },
      { type: 'caughtUp' },
    ]);
  });

  it('passes every record kept to every member, its author included, and catches a newcomer up before telling it is live', async () => {
    const relay = await relayWith();
    const first = await creator(relay);
    const one = sealedRecord('update', 1);
    first.send({ type: 'append', record: one });
    const echoed = await first.next();
    const second = await opener(relay);
    const arrival = [await second.next(), await second.next(), await second.next()];
    const joined = await first.next();
    const two = sealedRecord('update', 2);
    second.send({ type: 'append', record: two });
    expect([echoed, arrival, joined, await first.next(), await second.next()]).toEqual([
      { type: 'record', seq: 1, record: one },
      [
        { type: 'welcome', member: 2, verifyKey: ROOM_KEYS.verifyKey, members: [1] },
        { type: 'record', seq: 1, record: one },
        { type: 'caughtUp' },
      ],
      { type: 'joined', member: 2 },
      { type: 'record', seq: 2, record: two },
      { type: 'record', seq: 2, record: two },
    ]);
  });

  it('sends a member coming back only the records after the last one it has', async () => {
    const relay = await relayWith();
    const first = await creator(relay);
    const records = [1, 2, 3].map((byte) => sealedRecord('update', byte));
    for (const record of records) {
      first.send({ type: 'append', record });
      await first.next();
    }
    const back = await opener(relay, 2);
    expect([await back.next(), await back.next(), await back.next()]).toEqual([
      { type: 'welcome', member: 2, verifyKey: ROOM_KEYS.verifyKey, members: [1] },
      { type: 'record', seq: 3, record: records[2] },
      { type: 'caughtUp' },
    ]);
  });

  it('passes the presence of a member to the others only, and tells them when it leaves', async () => {
    const relay = await relayWith();
    const first = await creator(relay);
    const second = await opener(relay);
    await second.next();
    await second.next();
    await first.next();
    second.send({ type: 'presence', bytes: Uint8Array.of(7, 8) });
    const presence = await first.next();
    second.socket.close();
    expect([presence, await first.next(), second.received().length]).toEqual([
      { type: 'presence', member: 2, bytes: Uint8Array.of(7, 8) },
      { type: 'left', member: 2 },
      2,
    ]);
  });

  it('closes a room for good when its key signs it, telling every member, after which nobody can open it', async () => {
    const relay = await relayWith();
    const first = await creator(relay);
    const second = await opener(relay);
    await second.next();
    await second.next();
    await first.next();
    first.send(closeFrame(ROOM_KEYS));
    const told = [await first.next(), await second.next()];
    const codes = await Promise.all([first.closed, second.closed]);
    const late = await opener(relay);
    expect([told, codes, await late.next(), await late.closed]).toEqual([
      [{ type: 'closed' }, { type: 'closed' }],
      [CLOSE_NORMAL, CLOSE_NORMAL],
      { type: 'refused', reason: 'NO_ROOM' },
      CLOSE_REFUSED,
    ]);
  });

  it('keeps the rooms on disk for a relay started again', async () => {
    const relay = await relayWith();
    const first = await creator(relay);
    const record = sealedRecord('update', 1);
    first.send({ type: 'append', record });
    await first.next();
    await Promise.all(running.splice(0).map((started) => started.close()));
    const restarted = await relayWith();
    const back = await opener(restarted);
    expect([await back.next(), await back.next()]).toEqual([
      { type: 'welcome', member: 1, verifyKey: ROOM_KEYS.verifyKey, members: [] },
      { type: 'record', seq: 1, record },
    ]);
  });

  it('refuses a room that is not there, a room already there and a room whose creation is not signed by its key', async () => {
    const relay = await relayWith();
    const missing = await opener(relay);
    const missingAnswer = await missing.next();
    await creator(relay);
    const twice = await connectTo(relay.port);
    twice.send(createFrame(ROOM_KEYS));
    const forged = await connectTo(relay.port);
    const frame = createFrame(OTHER_KEYS);
    forged.send(frame.type === 'create' ? { ...frame, verifyKey: ROOM_KEYS.verifyKey } : frame);
    expect([missingAnswer, await twice.next(), await forged.next(), await forged.closed]).toEqual([
      { type: 'refused', reason: 'NO_ROOM' },
      { type: 'refused', reason: 'ROOM_EXISTS' },
      { type: 'refused', reason: 'BAD_SIGNATURE' },
      CLOSE_REFUSED,
    ]);
  });

  it('refuses a record or a closing not signed by the key of the room', async () => {
    const relay = await relayWith();
    const first = await creator(relay);
    const [stranger] = [sealedRecord('update', 9)].map((record) => {
      const forged = record.slice();
      forged[forged.length - 1] = (forged[forged.length - 1] ?? 0) ^ 1;
      return forged;
    });
    first.send({ type: 'append', record: stranger ?? new Uint8Array() });
    const second = await opener(relay);
    await second.next();
    await second.next();
    second.send(closeFrame(OTHER_KEYS));
    expect([await first.next(), await second.next()]).toEqual([
      { type: 'refused', reason: 'BAD_SIGNATURE' },
      { type: 'refused', reason: 'BAD_SIGNATURE' },
    ]);
  });

  it('refuses text, another version of the format, bytes that are not a frame, and a frame out of turn', async () => {
    const relay = await relayWith();
    const text = await connectTo(relay.port);
    text.socket.send('hello');
    const version = await connectTo(relay.port);
    version.socket.send(Uint8Array.of(2, 1));
    const garbage = await connectTo(relay.port);
    garbage.socket.send(Uint8Array.of(1, 99));
    const early = await connectTo(relay.port);
    early.send({ type: 'append', record: sealedRecord('update', 1) });
    const again = await creator(relay);
    again.send({ type: 'hello', roomId: ROOM_KEYS.roomId, since: 0 });
    expect(
      await Promise.all([text, version, garbage, early, again].map((client) => client.next())),
    ).toEqual([
      { type: 'refused', reason: 'MALFORMED' },
      { type: 'refused', reason: 'UNSUPPORTED_VERSION' },
      { type: 'refused', reason: 'MALFORMED' },
      { type: 'refused', reason: 'MALFORMED' },
      { type: 'refused', reason: 'MALFORMED' },
    ]);
  });

  it('refuses a frame sent while the room is still opening', async () => {
    const relay = await relayWith();
    await creator(relay);
    const hasty = await connectTo(relay.port);
    hasty.socket.send(
      Buffer.concat([encodeClientFrame({ type: 'hello', roomId: ROOM_KEYS.roomId, since: 0 })]),
    );
    hasty.send({ type: 'presence', bytes: Uint8Array.of(1) });
    expect(await hasty.next()).toEqual({ type: 'refused', reason: 'MALFORMED' });
  });

  it('closes a connection that says nothing for too long', async () => {
    const relay = await relayWith({}, { timings: { ...FAST, helloMilliseconds: 32 } });
    const silent = await connectTo(relay.port);
    expect([await silent.next(), await silent.closed]).toEqual([
      { type: 'refused', reason: 'MALFORMED' },
      CLOSE_REFUSED,
    ]);
  });

  it('cuts a connection that stopped answering its pings', async () => {
    const relay = await relayWith({}, { timings: { ...FAST, heartbeatMilliseconds: 32 } });
    const answering = await connectTo(relay.port);
    const mute = await connectTo(relay.port, { autoPong: false });
    expect([await mute.closed, answering.socket.readyState]).toEqual([
      CLOSE_ABNORMAL,
      answering.socket.OPEN,
    ]);
  });

  it('refuses a member sending frames faster than its share', async () => {
    const relay = await relayWith();
    const flooding = await creator(relay);
    for (let count = 0; count < 1_100; count += 1) {
      flooding.send({ type: 'presence', bytes: Uint8Array.of(1) });
    }
    expect(await flooding.next()).toEqual({ type: 'refused', reason: 'TOO_FAST' });
  });

  it('refuses connections beyond those of the relay, of one address, and coming too fast from one address', async () => {
    const full = await relayWith({ RELAY_MAX_CONNECTIONS: '1' });
    await connectTo(full.port);
    const beyondRelay = await connectTo(full.port);
    const perAddress = await relayWith({ RELAY_MAX_CONNECTIONS_PER_ADDRESS: '1' });
    await connectTo(perAddress.port);
    const beyondAddress = await connectTo(perAddress.port);
    const rate = await relayWith({ RELAY_CONNECTIONS_PER_MINUTE_PER_ADDRESS: '1' });
    await connectTo(rate.port);
    const tooFast = await connectTo(rate.port);
    expect(
      await Promise.all([beyondRelay, beyondAddress, tooFast].map((client) => client.next())),
    ).toEqual([
      { type: 'refused', reason: 'RELAY_FULL' },
      { type: 'refused', reason: 'TOO_MANY' },
      { type: 'refused', reason: 'TOO_FAST' },
    ]);
  });

  it('counts connections by the address a trusted proxy forwards, and by the connection otherwise', async () => {
    const trusting = await relayWith({
      RELAY_TRUST_PROXY: '1',
      RELAY_MAX_CONNECTIONS_PER_ADDRESS: '1',
    });
    /** Connects as if a proxy forwarded a connection from an address. */
    const from = (address: string) =>
      connectTo(trusting.port, { headers: { 'x-forwarded-for': `10.0.0.9, ${address}` } });
    const first = await from('203.0.113.1');
    const other = await from('203.0.113.2');
    const same = await from('203.0.113.1');
    const distrusting = await relayWith({ RELAY_MAX_CONNECTIONS_PER_ADDRESS: '1' });
    await connectTo(distrusting.port, { headers: { 'x-forwarded-for': '203.0.113.3' } });
    const ignored = await connectTo(distrusting.port, {
      headers: { 'x-forwarded-for': '203.0.113.4' },
    });
    expect([
      first.socket.readyState,
      other.socket.readyState,
      await same.next(),
      await ignored.next(),
    ]).toEqual([
      first.socket.OPEN,
      other.socket.OPEN,
      { type: 'refused', reason: 'TOO_MANY' },
      { type: 'refused', reason: 'TOO_MANY' },
    ]);
  });

  it('cuts a member that falls too far behind, as it will catch up once back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const relay = await relayWith(
      {},
      { sending: { highWaterBytes: 8_388_608, maxQueuedBytes: 0 } },
    );
    const stuck = await creator(relay);
    stuck.send({ type: 'append', record: sealedRecord('update', 1) });
    expect([await stuck.closed, warn.mock.calls]).toEqual([
      CLOSE_ABNORMAL,
      [['A member of a room fell too far behind and was cut.']],
    ]);
  });

  it('answers a web page that it is a relay', async () => {
    const relay = await relayWith();
    const answer = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        request(`http://127.0.0.1:${String(relay.port)}/`, (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          response.on('end', () => {
            resolve({ status: response.statusCode, body });
          });
        })
          .on('error', reject)
          .end();
      },
    );
    expect(answer).toEqual({ status: 426, body: 'This address is a Tasklace relay.\n' });
  });

  it('refuses to start on a port already taken', async () => {
    const relay = await relayWith();
    await expect(relayWith({ RELAY_PORT: String(relay.port) })).rejects.toThrow('EADDRINUSE');
  });

  it('stops even while a connection does not answer the closing, once its time is up', async () => {
    const relay = await relayWith({}, { timings: { ...FAST, closeMilliseconds: 32 } });
    const client = await connectTo(relay.port);
    client.socket.pause();
    await Promise.all(running.splice(0).map((started) => started.close()));
    client.socket.resume();
    expect(await client.closed).toBe(1001);
  });

  it('has let go of every room once stopped, a connection that does not answer the closing included', async () => {
    const openedAt = 1_700_000_000_000;
    const relay = await relayWith(
      {},
      { now: () => openedAt, timings: { ...FAST, closeMilliseconds: 32 } },
    );
    const client = await creator(relay);
    client.socket.pause();
    await Promise.all(running.splice(0).map((started) => started.close()));
    const file = path.join(folder, `${Buffer.from(ROOM_KEYS.roomId).toString('hex')}.room`);
    const touched = Math.round((await stat(file)).mtimeMs);
    client.socket.resume();
    await client.closed;
    expect(touched).toBe(openedAt);
  });
});
