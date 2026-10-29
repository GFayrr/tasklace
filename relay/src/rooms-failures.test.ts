import { readdir, type FileHandle } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRoomStore, type Room, type RoomStore } from './rooms.ts';
import {
  OTHER_KEYS,
  ROOM_KEYS,
  sealedRecord,
  sealedRecords,
  temporaryFolder,
} from './testing/relay-records.ts';

const failing = vi.hoisted(() => ({
  append: false,
  rewrite: false,
  create: false,
  utimes: false,
  rm: null as string | null,
  heldUtimes: null as Promise<void> | null,
  syncedAppends: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  /** Fails like a full disk when the test asks for it. */
  const diskFull = (): Error =>
    Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const [, flags] = args;
      const refused =
        (failing.append && flags === 'a') ||
        (failing.rewrite && flags === 'w') ||
        (failing.create && flags === 'wx');
      if (refused) {
        throw diskFull();
      }
      const handle = await original.open(...args);
      return flags === 'a' ? countingSyncs(handle) : handle;
    },
    rm: (...args: Parameters<typeof original.rm>) =>
      failing.rm !== null && String(args[0]).includes(failing.rm)
        ? Promise.reject(Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }))
        : original.rm(...args),
    utimes: async (...args: Parameters<typeof original.utimes>) => {
      await failing.heldUtimes;
      return failing.utimes ? Promise.reject(diskFull()) : original.utimes(...args);
    },
  };
});

/** Counts how often the records appended to a file are pushed to the disk. */
function countingSyncs(handle: FileHandle): FileHandle {
  const sync = handle.sync.bind(handle);
  handle.sync = async () => {
    failing.syncedAppends += 1;
    await sync();
  };
  return handle;
}

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
  Object.assign(failing, {
    append: false,
    rewrite: false,
    create: false,
    utimes: false,
    rm: null,
    heldUtimes: null,
    syncedAppends: 0,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeFolder();
});

/** Opens the rooms of the folder of the test, at a time of its clock. */
function storeOf(now = (): number => 0): Promise<RoomStore> {
  return openRoomStore({
    directory: folder,
    limits: {
      maxRooms: 8,
      maxRoomBytes: 1_048_576,
      maxStoredBytes: 4_194_304,
      expiryMilliseconds: 1_000,
    },
    now,
    roomFailed: (room) => failed.push(room),
  });
}

/** Sends one message to a room, giving the refusal of its chunks or the records once written. */
async function sent(store: RoomStore, room: Room, records: readonly Uint8Array[]) {
  const staging = store.stage(room);
  for (const record of records) {
    const taken = staging.take(record);
    if (taken !== null) {
      return typeof taken === 'string' ? taken : await taken;
    }
  }
  return null;
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
    failing.append = true;
    const written = await Promise.all([
      sent(store, room, [sealedRecord('update', 1)]),
      sent(store, room, [sealedRecord('update', 2)]),
    ]);
    const afterwards = store.stage(room).take(sealedRecord('update', 3));
    failing.append = false;
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
      'RELAY_FAILED',
      [room],
      0,
      [`The room ${room.name} could not be written:`],
    ]);
  });

  it('tells that a room failed when its file cannot be rewritten after a snapshot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = await storeOf();
    const room = await createdRoom(store);
    await sent(store, room, [sealedRecord('update', 1)]);
    failing.rewrite = true;
    await sent(store, room, sealedRecords('snapshot', 2, 4, 1));
    await store.settle();
    expect([failed, room.entries.map((entry) => entry.seq)]).toEqual([[room], [1, 2]]);
  });

  it('pushes the records of each message to the disk before giving their sequences, once per message', async () => {
    const store = await storeOf();
    const room = await createdRoom(store);
    const written = await sent(store, room, sealedRecords('update', 1, 100));
    expect([written?.length ?? null, failing.syncedAppends]).toEqual([2, 1]);
  });

  it('keeps a room whose file could not be removed, so that it does not come back unannounced, and removes it once the disk lets it', async () => {
    const store = await storeOf();
    const room = await createdRoom(store);
    failing.rm = room.name;
    const refused = await store.remove(room).catch((error: unknown) => (error as Error).message);
    const stillThere = await readdir(folder);
    failing.rm = null;
    await store.remove(room);
    expect([
      refused,
      stillThere,
      await readdir(folder),
      await store.open(ROOM_KEYS.roomId),
    ]).toEqual(['Operation not permitted', [`${room.name}.room`], [], null]);
  });

  it('carries on removing the rooms nobody opens past one whose file cannot be removed, logging it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let time = 0;
    const store = await storeOf(() => time);
    const first = await createdRoom(store);
    const second = await store.create(OTHER_KEYS.roomId, OTHER_KEYS.verifyKey);
    await store.release(first);
    if (typeof second !== 'string') {
      await store.release(second);
    }
    failing.rm = first.name;
    time = 2_000;
    const removed = await store.expire();
    expect([
      removed,
      await readdir(folder),
      error.mock.calls.map(([message]: unknown[]) => message),
    ]).toEqual([
      1,
      [`${first.name}.room`],
      [`The room ${first.name} nobody opens could not be removed:`],
    ]);
  });

  it('keeps a room nobody opened for long once a member opens it while the rooms nobody opens are being removed', async () => {
    let time = 0;
    const store = await storeOf(() => time);
    const first = await createdRoom(store);
    const second = await store.create(OTHER_KEYS.roomId, OTHER_KEYS.verifyKey);
    await store.release(first);
    if (typeof second !== 'string') {
      await store.release(second);
    }
    time = 2_000;
    let letGo = (): void => undefined;
    failing.heldUtimes = new Promise((resolve) => {
      letGo = resolve;
    });
    const expiring = store.expire();
    const reopened = store.open(OTHER_KEYS.roomId);
    letGo();
    const [removed, room] = await Promise.all([expiring, reopened]);
    expect([removed, room?.name, await readdir(folder)]).toEqual([
      1,
      typeof second === 'string' ? '' : second.name,
      [`${typeof second === 'string' ? '' : second.name}.room`],
    ]);
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

  it('waits for a room being released when asked to settle, so that nothing touches its file afterwards', async () => {
    const store = await storeOf();
    const room = await createdRoom(store);
    let letGo = (): void => undefined;
    failing.heldUtimes = new Promise((resolve) => {
      letGo = resolve;
    });
    const steps: string[] = [];
    const released = store.release(room).then(() => steps.push('released'));
    const settled = store.settle().then(() => steps.push('settled'));
    await new Promise((resolve) => setImmediate(resolve));
    letGo();
    await Promise.all([released, settled]);
    expect(steps).toEqual(['released', 'settled']);
  });
});
