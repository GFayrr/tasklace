import { utimes } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRelayServer, type RelayTimings, type RunningRelay } from './server.ts';
import {
  closeFrame,
  connectTo,
  createFrame,
  testConfig,
  type TestClient,
} from './testing/relay-client.ts';
import { ROOM_KEYS, sealedRecord, temporaryFolder } from './testing/relay-records.ts';

const failing = vi.hoisted(() => ({
  append: false,
  readFile: false,
  rm: false,
  heldAppend: null as Promise<void> | null,
  appends: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  /** Fails like a disk that gave up when the test asks for it. */
  const broken = (): Error => Object.assign(new Error('Input/output error'), { code: 'EIO' });
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      if (args[1] === 'a') {
        failing.appends += 1;
        await failing.heldAppend;
      }
      return failing.append && args[1] === 'a' ? Promise.reject(broken()) : original.open(...args);
    },
    readFile: (...args: Parameters<typeof original.readFile>) =>
      failing.readFile ? Promise.reject(broken()) : original.readFile(...args),
    rm: (...args: Parameters<typeof original.rm>) =>
      failing.rm ? Promise.reject(broken()) : original.rm(...args),
  };
});

const DAY = 86_400_000;
const TIMINGS: RelayTimings = {
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
  Object.assign(failing, {
    append: false,
    readFile: false,
    rm: false,
    heldAppend: null,
    appends: 0,
  });
});

afterEach(async () => {
  Object.assign(failing, {
    append: false,
    readFile: false,
    rm: false,
    heldAppend: null,
    appends: 0,
  });
  await Promise.all(running.splice(0).map((relay) => relay.close()));
  vi.restoreAllMocks();
  await removeFolder();
});

/** Starts a relay for the test. */
async function started(timings: RelayTimings = TIMINGS): Promise<RunningRelay> {
  const relay = await startRelayServer({ config: testConfig(folder), timings });
  running.push(relay);
  return relay;
}

/** Gives the type of a frame a relay sent, or what it was when it was not one. */
function typeOf(frame: Awaited<ReturnType<TestClient['next']>>): string | null {
  return frame === null || frame === 'UNSUPPORTED_VERSION' ? frame : frame.type;
}

describe('a relay whose disk fails', () => {
  it('turns every member of a room away once a record of it cannot be written', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const relay = await started();
    const first = await connectTo(relay.port);
    first.send(createFrame(ROOM_KEYS));
    await first.next();
    await first.next();
    failing.append = true;
    first.send({ type: 'append', record: sealedRecord('update', 1) });
    expect([await first.next(), error.mock.calls.length]).toEqual([
      { type: 'refused', reason: 'RELAY_FAILED' },
      1,
    ]);
  });

  it('passes a record written slowly to a member who came in meanwhile, after everyone else had left', async () => {
    const relay = await started();
    const author = await connectTo(relay.port);
    author.send(createFrame(ROOM_KEYS));
    await author.next();
    await author.next();
    let letGo = (): void => undefined;
    failing.heldAppend = new Promise((resolve) => {
      letGo = resolve;
    });
    const record = sealedRecord('update', 1);
    author.send({ type: 'append', record });
    await vi.waitFor(() => {
      expect(failing.appends).toBe(1);
    });
    author.socket.close();
    await author.closed;
    const newcomer = await connectTo(relay.port);
    newcomer.send({ type: 'hello', roomId: ROOM_KEYS.roomId, since: 0 });
    const welcome = await newcomer.next();
    const caughtUp = await newcomer.next();
    letGo();
    expect([typeOf(welcome), caughtUp, await newcomer.next()]).toEqual([
      'welcome',
      { type: 'caughtUp' },
      { type: 'record', seq: 1, record },
    ]);
  });

  it('turns a member away when its room cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const relay = await started();
    const first = await connectTo(relay.port);
    first.send(createFrame(ROOM_KEYS));
    await first.next();
    first.socket.close();
    await first.closed;
    failing.readFile = true;
    const back = await connectTo(relay.port);
    back.send({ type: 'hello', roomId: ROOM_KEYS.roomId, since: 0 });
    expect([await back.next(), error.mock.calls.map(([message]: unknown[]) => message)]).toEqual([
      { type: 'refused', reason: 'RELAY_FAILED' },
      ['A room could not be opened:'],
    ]);
  });

  it('turns every member of a room away as for a failure of the relay, the room staying, when its file cannot be removed to close it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const relay = await started();
    const first = await connectTo(relay.port);
    first.send(createFrame(ROOM_KEYS));
    await first.next();
    await first.next();
    failing.rm = true;
    first.send(closeFrame(ROOM_KEYS));
    const name = Buffer.from(ROOM_KEYS.roomId).toString('hex');
    const answer = await first.next();
    failing.rm = false;
    const back = await connectTo(relay.port);
    back.send({ type: 'hello', roomId: ROOM_KEYS.roomId, since: 0 });
    expect([
      answer,
      typeOf(await back.next()),
      error.mock.calls.map(([message]: unknown[]) => message),
    ]).toEqual([
      { type: 'refused', reason: 'RELAY_FAILED' },
      'welcome',
      [`The room ${name} could not be removed:`],
    ]);
  });

  it('removes the rooms nobody opened for too long when it starts, telling how many, and tells when it cannot', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const relay = await started();
    const first = await connectTo(relay.port);
    first.send(createFrame(ROOM_KEYS));
    await first.next();
    first.socket.close();
    await first.closed;
    await Promise.all(running.splice(0).map((stopped) => stopped.close()));
    const file = path.join(folder, `${Buffer.from(ROOM_KEYS.roomId).toString('hex')}.room`);
    const longAgo = (Date.now() - 91 * DAY) / 1_000;
    await utimes(file, longAgo, longAgo);
    failing.rm = true;
    await started({ ...TIMINGS, sweepMilliseconds: 16 });
    await vi.waitFor(() => {
      expect(error.mock.calls.length).toBeGreaterThan(0);
    });
    failing.rm = false;
    await vi.waitFor(() => {
      expect(info.mock.calls.length).toBeGreaterThan(0);
    });
    expect([error.mock.calls[0]?.[0], info.mock.calls]).toEqual([
      `The room ${Buffer.from(ROOM_KEYS.roomId).toString('hex')} nobody opens could not be removed:`,
      [['1 rooms nobody opened for a long time were removed.']],
    ]);
  });
});
