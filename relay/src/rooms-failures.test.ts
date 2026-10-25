import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRoomStore, type Room, type RoomStore } from './rooms.ts';
import {
  ROOM_KEYS,
  sealedRecord,
  sealedRecords,
  temporaryFolder,
} from './testing/relay-records.ts';

const failing = vi.hoisted(() => ({
  appendFile: false,
  rewrite: false,
  create: false,
  utimes: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  /** Fails like a full disk when the test asks for it. */
  const diskFull = (): Error =>
    Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
  return {
    ...original,
    appendFile: (...args: Parameters<typeof original.appendFile>) =>
      failing.appendFile ? Promise.reject(diskFull()) : original.appendFile(...args),
    open: (...args: Parameters<typeof original.open>) => {
      const [, flags] = args;
      if ((failing.rewrite && flags === 'w') || (failing.create && flags === 'wx')) {
        return Promise.reject(diskFull());
      }
      return original.open(...args);
    },
    utimes: (...args: Parameters<typeof original.utimes>) =>
      failing.utimes ? Promise.reject(diskFull()) : original.utimes(...args),
  };
});

vi.mock('../../src/core/collaboration/relay/relay-wire.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/collaboration/relay/relay-wire.ts')>()),
  RELAY_CHUNK_BYTES: 64,
}));

let folder: string;
let removeFolder: () => Promise<void>;
let failed: Room[];

beforeEach(async () => {
  ({ folder, remove: removeFolder } = await temporaryFolder());
  failed = [];
  Object.assign(failing, { appendFile: false, rewrite: false, create: false, utimes: false });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeFolder();
});

/** Opens the rooms of the folder of the test. */
function storeOf(): Promise<RoomStore> {
  return openRoomStore({
    directory: folder,
    limits: {
      maxRooms: 8,
      maxRoomBytes: 1_048_576,
      maxStoredBytes: 4_194_304,
      expiryMilliseconds: 1_000,
    },
    now: () => 0,
    roomFailed: (room) => failed.push(room),
  });
}

/** Creates the room of the test keys. */
async function createdRoom(store: RoomStore): Promise<Room> {
  const room = await store.create(ROOM_KEYS.roomId, ROOM_KEYS.verifyKey);
  if (typeof room === 'string') {
    throw new Error(room);
  }
  return room;
}

describe('the rooms of a relay when the disk fails', () => {
  it('tells once that a room failed when a record cannot be written, keeps nothing more in it, and reads it whole again once reopened', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = await storeOf();
    const room = await createdRoom(store);
    failing.appendFile = true;
    const first = store.append(room, sealedRecord('update', 1));
    const second = store.append(room, sealedRecord('update', 2));
    const written = await Promise.all([first, second]);
    const afterwards = store.append(room, sealedRecord('update', 3));
    failing.appendFile = false;
    await store.release(room);
    const reopened = await store.open(ROOM_KEYS.roomId);
    expect([
      written,
      afterwards,
      failed,
      reopened?.entries.length,
      error.mock.calls.map(([message]: unknown[]) => message),
    ]).toEqual([
      [null, null],
      'RELAY_FULL',
      [room],
      0,
      [`The room ${room.name} could not be written:`],
    ]);
  });

  it('tells that a room failed when its file cannot be rewritten after a snapshot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = await storeOf();
    const room = await createdRoom(store);
    const update = store.append(room, sealedRecord('update', 1));
    await update;
    failing.rewrite = true;
    for (const record of sealedRecords('snapshot', 2, 4, 1)) {
      await store.append(room, record);
    }
    await store.settle();
    expect([failed, room.entries.map((entry) => entry.seq)]).toEqual([[room], [1, 2]]);
  });

  it('forgets a room whose file could not be created, so that it can be created again', async () => {
    const store = await storeOf();
    failing.create = true;
    const refused = await store
      .create(ROOM_KEYS.roomId, ROOM_KEYS.verifyKey)
      .catch((error: unknown) => (error instanceof Error ? error.message : error));
    failing.create = false;
    const room = await createdRoom(store);
    expect([refused, room.entries, await readdir(folder)]).toEqual([
      'No space left on device',
      [],
      [`${room.name}.room`],
    ]);
  });

  it('still opens a room whose file cannot keep the date it was opened, warning about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await storeOf();
    await store.release(await createdRoom(store));
    failing.utimes = true;
    const room = await store.open(ROOM_KEYS.roomId);
    expect([room?.name, warn.mock.calls.map(([message]: unknown[]) => message)]).toEqual([
      Buffer.from(ROOM_KEYS.roomId).toString('hex'),
      [`The room ${room?.name ?? ''} could not keep the date it was opened:`],
    ]);
  });
});
