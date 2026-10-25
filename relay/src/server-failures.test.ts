import { utimes } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRelayServer, type RelayTimings, type RunningRelay } from './server.ts';
import { closeFrame, connectTo, createFrame, testConfig } from './testing/relay-client.ts';
import { ROOM_KEYS, sealedRecord, temporaryFolder } from './testing/relay-records.ts';

const failing = vi.hoisted(() => ({ appendFile: false, readFile: false, rm: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  /** Fails like a disk that gave up when the test asks for it. */
  const broken = (): Error => Object.assign(new Error('Input/output error'), { code: 'EIO' });
  return {
    ...original,
    appendFile: (...args: Parameters<typeof original.appendFile>) =>
      failing.appendFile ? Promise.reject(broken()) : original.appendFile(...args),
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
  Object.assign(failing, { appendFile: false, readFile: false, rm: false });
});

afterEach(async () => {
  Object.assign(failing, { appendFile: false, readFile: false, rm: false });
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

describe('a relay whose disk fails', () => {
  it('turns every member of a room away once a record of it cannot be written', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const relay = await started();
    const first = await connectTo(relay.port);
    first.send(createFrame(ROOM_KEYS));
    await first.next();
    await first.next();
    failing.appendFile = true;
    first.send({ type: 'append', record: sealedRecord('update', 1) });
    expect([await first.next(), error.mock.calls.length]).toEqual([
      { type: 'refused', reason: 'RELAY_FULL' },
      1,
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
      { type: 'refused', reason: 'RELAY_FULL' },
      ['A room could not be opened:'],
    ]);
  });

  it('still tells every member a room closed when its file cannot be removed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const relay = await started();
    const first = await connectTo(relay.port);
    first.send(createFrame(ROOM_KEYS));
    await first.next();
    await first.next();
    failing.rm = true;
    first.send(closeFrame(ROOM_KEYS));
    const name = Buffer.from(ROOM_KEYS.roomId).toString('hex');
    expect([await first.next(), error.mock.calls.map(([message]: unknown[]) => message)]).toEqual([
      { type: 'closed' },
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
      'The rooms nobody opens could not be removed:',
      [['1 rooms nobody opened for a long time were removed.']],
    ]);
  });
});
