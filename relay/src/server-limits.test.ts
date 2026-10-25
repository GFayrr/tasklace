import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRelayServer, type RunningRelay } from './server.ts';
import { connectTo, createFrame, testConfig } from './testing/relay-client.ts';
import { ROOM_KEYS, temporaryFolder } from './testing/relay-records.ts';

vi.mock('../../src/core/collaboration/relay/relay-wire.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/collaboration/relay/relay-wire.ts')>()),
  MAX_RELAY_MEMBERS: 1,
}));

let folder: string;
let removeFolder: () => Promise<void>;
let relay: RunningRelay;

beforeEach(async () => {
  ({ folder, remove: removeFolder } = await temporaryFolder());
  relay = await startRelayServer({ config: testConfig(folder) });
});

afterEach(async () => {
  await relay.close();
  await removeFolder();
});

describe('a relay at the members a room holds', () => {
  it('refuses one more member, and lets one in again once a member left', async () => {
    const first = await connectTo(relay.port);
    first.send(createFrame(ROOM_KEYS));
    await first.next();
    const refused = await connectTo(relay.port);
    refused.send({ type: 'hello', roomId: ROOM_KEYS.roomId, since: 0 });
    const answer = await refused.next();
    first.socket.close();
    await first.closed;
    const later = await connectTo(relay.port);
    later.send({ type: 'hello', roomId: ROOM_KEYS.roomId, since: 0 });
    expect([answer, (await later.next())?.valueOf()]).toEqual([
      { type: 'refused', reason: 'ROOM_FULL' },
      { type: 'welcome', member: 1, verifyKey: ROOM_KEYS.verifyKey, members: [] },
    ]);
  });
});
