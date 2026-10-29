import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRoomEntry, ENTRY_HEADER_BYTES, ROOM_HEADER_BYTES } from './room-file.ts';
import {
  openRoomStore,
  type AppendRefusal,
  type Room,
  type RoomLimits,
  type RoomStore,
} from './rooms.ts';
import {
  OTHER_KEYS,
  ROOM_KEYS,
  sealedRecord,
  sealedRecords,
  temporaryFolder,
} from './testing/relay-records.ts';

vi.mock('../../src/core/collaboration/relay/relay-wire.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/collaboration/relay/relay-wire.ts')>()),
  RELAY_CHUNK_BYTES: 64,
}));

const DAY = 86_400_000;
const ROOMY: RoomLimits = {
  maxRooms: 8,
  maxRoomBytes: 1_048_576,
  maxStoredBytes: 4_194_304,
  expiryMilliseconds: 90 * DAY,
};

let folder: string;
let removeFolder: () => Promise<void>;
let time: number;
let failed: Room[];
let stores: RoomStore[];

beforeEach(async () => {
  ({ folder, remove: removeFolder } = await temporaryFolder());
  time = 1_000 * DAY;
  failed = [];
  stores = [];
});

afterEach(async () => {
  await Promise.all(stores.map((store) => store.settle()));
  await removeFolder();
});

/** Opens the rooms of the folder of the test with some limits. */
async function storeWith(limits: RoomLimits = ROOMY): Promise<RoomStore> {
  const store = await openRoomStore({
    directory: folder,
    limits,
    now: () => time,
    roomFailed: (room) => failed.push(room),
  });
  stores.push(store);
  return store;
}

/** Creates the room of the test keys, failing the test when it cannot be. */
async function createdRoom(store: RoomStore): Promise<Room> {
  const room = await store.create(ROOM_KEYS.roomId, ROOM_KEYS.verifyKey);
  if (typeof room === 'string') {
    throw new Error(`The room could not be created: ${room}`);
  }
  return room;
}

/** Sends the chunks of one message to a room, giving the refusal of the first chunk refused, what a message still waiting for chunks gives, or the sequences the room kept it under once written. */
async function appendMessage(
  store: RoomStore,
  room: Room,
  records: readonly Uint8Array[],
): Promise<AppendRefusal | number[] | null> {
  const staging = store.stage(room);
  for (const record of records) {
    const taken = staging.take(record);
    if (taken === null) {
      continue;
    }
    return typeof taken === 'string' ? taken : ((await taken)?.map((entry) => entry.seq) ?? null);
  }
  return null;
}

/** Appends messages of one record each, failing the test when one is refused, and gives the sequences they were kept under. */
async function appendAll(store: RoomStore, room: Room, records: readonly Uint8Array[]) {
  const sequences: number[] = [];
  for (const record of records) {
    sequences.push(...(await keptMessage(store, room, [record])));
  }
  return sequences;
}

/** Appends one message, failing the test when it is refused or not written, and gives the sequences it was kept under. */
async function keptMessage(store: RoomStore, room: Room, records: readonly Uint8Array[]) {
  const kept = await appendMessage(store, room, records);
  if (!Array.isArray(kept)) {
    throw new Error(`The message was not kept: ${String(kept)}`);
  }
  return kept;
}

/** Gives the sequences a room holds. */
function sequencesOf(room: Room | null): number[] | null {
  return room?.entries.map((entry) => entry.seq) ?? null;
}

describe('the rooms of a relay', () => {
  it('keeps the records of a room in its file, numbered one after the other, and reads them back after a restart', async () => {
    const store = await storeWith();
    const room = await createdRoom(store);
    const records = [sealedRecord('update', 1), sealedRecord('update', 2)];
    const sequences = await appendAll(store, room, records);
    await store.release(room);
    const reopened = await (await storeWith()).open(ROOM_KEYS.roomId);
    expect([
      sequences,
      reopened?.verifyKey,
      reopened?.entries.map((entry) => [entry.seq, entry.record]),
    ]).toEqual([
      [1, 2],
      ROOM_KEYS.verifyKey,
      [
        [1, records[0]],
        [2, records[1]],
      ],
    ]);
  });

  it('carries on numbering after the last record kept once restarted', async () => {
    const store = await storeWith();
    const room = await createdRoom(store);
    await appendAll(store, room, [sealedRecord('update', 1)]);
    await store.release(room);
    const restarted = await storeWith();
    const reopened = await restarted.open(ROOM_KEYS.roomId);
    expect(
      reopened === null ? null : await appendAll(restarted, reopened, [sealedRecord('update', 2)]),
    ).toEqual([2]);
  });

  it('refuses a room already there, beyond the number of rooms or beyond the bytes of the relay', async () => {
    const store = await storeWith({ ...ROOMY, maxRooms: 1 });
    await createdRoom(store);
    const again = await store.create(ROOM_KEYS.roomId, ROOM_KEYS.verifyKey);
    const another = await store.create(OTHER_KEYS.roomId, OTHER_KEYS.verifyKey);
    const crowded = await (
      await openRoomStore({
        directory: path.join(folder, 'other'),
        limits: { ...ROOMY, maxStoredBytes: ROOM_HEADER_BYTES - 1 },
        now: () => time,
        roomFailed: () => undefined,
      })
    ).create(OTHER_KEYS.roomId, OTHER_KEYS.verifyKey);
    const notKey = await (
      await openRoomStore({
        directory: path.join(folder, 'third'),
        limits: ROOMY,
        now: () => time,
        roomFailed: () => undefined,
      })
    ).create(OTHER_KEYS.roomId, new Uint8Array(31));
    expect([again, another, crowded, notKey]).toEqual([
      'ROOM_EXISTS',
      'RELAY_FULL',
      'RELAY_FULL',
      'RELAY_FULL',
    ]);
  });

  it('opens nothing for a room it does not hold', async () => {
    const store = await storeWith();
    expect(await store.open(OTHER_KEYS.roomId)).toBe(null);
  });

  it('refuses a record not signed with the key of the room, bytes that are not a record, a message already there, a message that does not start with its first chunk and a chunk of another message in the middle of one', async () => {
    const store = await storeWith();
    const room = await createdRoom(store);
    const [first, second] = sealedRecords('update', 3, 100);
    const [other] = sealedRecords('update', 6, 100);
    if (first === undefined || second === undefined || other === undefined) {
      throw new Error('Two records were expected.');
    }
    const kept = await keptMessage(store, room, [sealedRecord('update', 2)]);
    const interrupted = store.stage(room);
    const refusals = [
      store.stage(room).take(sealedRecords('update', 4, 4, 0, OTHER_KEYS)[0] ?? new Uint8Array()),
      store.stage(room).take(Uint8Array.of(1, 2, 3)),
      store.stage(room).take(sealedRecord('update', 2)),
      store.stage(room).take(second),
      [interrupted.take(first), interrupted.take(other)],
    ];
    expect([kept, refusals, await appendMessage(store, room, [first, second])]).toEqual([
      [1],
      ['BAD_SIGNATURE', 'MALFORMED', 'MALFORMED', 'MALFORMED', [null, 'MALFORMED']],
      [2, 3],
    ]);
  });

  it('keeps nothing of a message whose last chunks never came, giving back the room it held', async () => {
    const [first] = sealedRecords('update', 3, 100);
    const size = ENTRY_HEADER_BYTES + (first?.length ?? 0);
    const store = await storeWith({ ...ROOMY, maxRoomBytes: ROOM_HEADER_BYTES + 2 * size });
    const room = await createdRoom(store);
    const staging = store.stage(room);
    const waiting = staging.take(first ?? new Uint8Array());
    const whileWaiting = store.stage(room).take(first ?? new Uint8Array());
    staging.cancel();
    const afterwards = await appendMessage(store, room, sealedRecords('update', 3, 100));
    expect([waiting, whileWaiting, afterwards, sequencesOf(room)]).toEqual([
      null,
      'TOO_LARGE',
      [1, 2],
      [1, 2],
    ]);
  });

  it('refuses a snapshot covering a record not there yet', async () => {
    const store = await storeWith();
    const room = await createdRoom(store);
    await appendAll(store, room, [sealedRecord('update', 1)]);
    expect([
      store.stage(room).take(sealedRecord('snapshot', 2, 4, 2)),
      await appendMessage(store, room, [sealedRecord('snapshot', 3, 4, 1)]),
    ]).toEqual(['MALFORMED', [2]]);
  });

  it('refuses a record whose author had seen less than what a snapshot freed, as a replay of a record the room dropped', async () => {
    const store = await storeWith();
    const room = await createdRoom(store);
    const old = sealedRecord('update', 1);
    await appendAll(store, room, [old, sealedRecord('update', 2)]);
    await keptMessage(store, room, [sealedRecord('snapshot', 3, 4, 2)]);
    await store.settle();
    const fresh = sealedRecords('update', 4, 4, 0, ROOM_KEYS, 3);
    expect([
      store.stage(room).take(old),
      await appendMessage(store, room, sealedRecords('update', 5, 4, 0, ROOM_KEYS, 1)),
      await appendMessage(store, room, fresh),
    ]).toEqual(['STALE', 'STALE', [4]]);
  });

  it('refuses a change beyond the bytes of a room, from its first chunk for a message of several, while a snapshot may go a whole room beyond to replace what it covers', async () => {
    const update = sealedRecord('update', 1);
    const size = ENTRY_HEADER_BYTES + update.length;
    const store = await storeWith({ ...ROOMY, maxRoomBytes: ROOM_HEADER_BYTES + size });
    const room = await createdRoom(store);
    await appendAll(store, room, [update]);
    const refused = store.stage(room).take(sealedRecord('update', 2));
    const refusedFirst = store.stage(room).take(sealedRecords('update', 3, 100)[0] ?? update);
    const snapshot = sealedRecord('snapshot', 4, 4, 1);
    await appendAll(store, room, [snapshot]);
    await store.settle();
    expect([refused, refusedFirst, sequencesOf(room)]).toEqual(['TOO_LARGE', 'TOO_LARGE', [2]]);
  });

  it('refuses a record beyond the bytes of the whole relay, a snapshot having the same room more', async () => {
    const update = sealedRecord('update', 1);
    const size = ENTRY_HEADER_BYTES + update.length;
    const store = await storeWith({
      ...ROOMY,
      maxRoomBytes: 4 * size,
      maxStoredBytes: ROOM_HEADER_BYTES + size,
    });
    const room = await createdRoom(store);
    await appendAll(store, room, [update]);
    const refused = store.stage(room).take(sealedRecord('update', 2));
    const kept = await appendAll(store, room, [sealedRecord('snapshot', 3, 4, 1)]);
    expect([refused, kept]).toEqual(['RELAY_FULL', [2]]);
  });

  it('drops, once a whole snapshot is in, every message whose chunks all came at or before what it covers, and frees their bytes', async () => {
    const store = await storeWith();
    const room = await createdRoom(store);
    const several = sealedRecords('update', 3, 100);
    const late = sealedRecord('update', 4);
    await appendAll(store, room, [sealedRecord('update', 1), sealedRecord('update', 2)]);
    await keptMessage(store, room, several);
    await appendAll(store, room, [late]);
    const snapshot = sealedRecords('snapshot', 5, 100, 4);
    await keptMessage(store, room, snapshot);
    await store.release(room);
    const onDisk = await (await storeWith()).open(ROOM_KEYS.roomId);
    const fileBytes = (await stat(path.join(folder, `${room.name}.room`))).size;
    const expectedBytes =
      ROOM_HEADER_BYTES +
      [late, ...snapshot].reduce((total, record) => total + ENTRY_HEADER_BYTES + record.length, 0);
    expect([several.length, sequencesOf(room), sequencesOf(onDisk), fileBytes]).toEqual([
      2,
      [5, 6, 7],
      [5, 6, 7],
      expectedBytes,
    ]);
  });

  it('keeps a room in memory while one member still holds it, and lets a new store read what was written', async () => {
    const store = await storeWith();
    const room = await createdRoom(store);
    const again = await store.open(ROOM_KEYS.roomId);
    await store.release(room);
    const stillOpen = typeof store.stage(room).take(sealedRecord('update', 1));
    if (again !== null) {
      await store.release(again);
    }
    const afterwards = store.stage(room).take(sealedRecord('update', 2));
    expect([again === room, stillOpen, afterwards]).toEqual([true, 'object', 'RELAY_FAILED']);
  });

  it('loads a room once however many members open it at the same time', async () => {
    const store = await storeWith();
    await store.release(await createdRoom(store));
    const reopened = await storeWith();
    const rooms = await Promise.all([1, 2, 3].map(() => reopened.open(ROOM_KEYS.roomId)));
    expect(new Set(rooms).size).toBe(1);
  });

  it('removes a room for good, letting a room with the same name be created again', async () => {
    const store = await storeWith();
    const room = await createdRoom(store);
    await appendAll(store, room, [sealedRecord('update', 1)]);
    await store.remove(room);
    await store.remove(room);
    const gone = await store.open(ROOM_KEYS.roomId);
    const recreated = await createdRoom(store);
    expect([gone, sequencesOf(recreated), await readdir(folder)]).toEqual([
      null,
      [],
      [`${room.name}.room`],
    ]);
  });

  it('removes the rooms nobody opened for longer than the relay keeps them, never one in use', async () => {
    const store = await storeWith();
    const stale = await createdRoom(store);
    await store.release(stale);
    const inUse = await store.create(OTHER_KEYS.roomId, OTHER_KEYS.verifyKey);
    time += 90 * DAY;
    const atTheLimit = await store.expire();
    time += 1;
    const removed = await store.expire();
    expect([atTheLimit, removed, typeof inUse, await readdir(folder)]).toEqual([
      0,
      1,
      'object',
      [`${typeof inUse === 'string' ? '' : inUse.name}.room`],
    ]);
  });

  it('counts the days of a room from when its file was last opened, after a restart too', async () => {
    const store = await storeWith();
    const room = await createdRoom(store);
    await store.release(room);
    const file = path.join(folder, `${room.name}.room`);
    const longAgo = (time - 91 * DAY) / 1_000;
    await utimes(file, longAgo, longAgo);
    expect(await (await storeWith()).expire()).toBe(1);
  });

  it('cuts what a crash left of a message half written after copying the file aside, sets aside a file that is not a room, removes a rewrite left halfway and ignores other files', async () => {
    const store = await storeWith();
    const room = await createdRoom(store);
    await appendAll(store, room, [sealedRecord('update', 1)]);
    await store.release(room);
    const file = path.join(folder, `${room.name}.room`);
    const whole = await readFile(file);
    const [firstChunk, secondChunk] = sealedRecords('update', 2, 100);
    const whole2 = encodeRoomEntry({ seq: 2, record: firstChunk ?? new Uint8Array() });
    const cut = encodeRoomEntry({ seq: 3, record: secondChunk ?? new Uint8Array() });
    const dropped = whole2.length + 10;
    await writeFile(file, Buffer.concat([whole, whole2, cut.subarray(0, 10)]));
    const otherName = Buffer.from(OTHER_KEYS.roomId).toString('hex');
    await writeFile(path.join(folder, `${otherName}.room`), 'not a room');
    await writeFile(path.join(folder, `${room.name}.room.tmp`), 'halfway');
    await writeFile(path.join(folder, 'notes.txt'), 'kept');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const restarted = await storeWith();
    const reopened = await restarted.open(ROOM_KEYS.roomId);
    const damaged = await restarted.open(OTHER_KEYS.roomId);
    const recreated = typeof (await restarted.create(OTHER_KEYS.roomId, OTHER_KEYS.verifyKey));
    expect([
      sequencesOf(reopened),
      (await stat(file)).size,
      damaged,
      recreated,
      (await readdir(folder)).sort(),
      warn.mock.calls,
      error.mock.calls,
    ]).toEqual([
      [1],
      whole.length,
      null,
      'object',
      [
        `${otherName}.room`,
        `${otherName}.room.damaged-${String(time)}`,
        `${room.name}.room`,
        `${room.name}.room.damaged-${String(time)}`,
        'notes.txt',
      ],
      [
        [
          `The room file ${file} ended with ${String(dropped)} bytes of a message cut short, which were dropped; the whole file was copied to ${file}.damaged-${String(time)}.`,
        ],
      ],
      [[`${path.join(folder, otherName)}.room is not the file of a room and was set aside.`]],
    ]);
  });

  it('waits for every write in progress when asked to settle', async () => {
    const store = await storeWith();
    const room = await createdRoom(store);
    const written = store.stage(room).take(sealedRecord('update', 1));
    await store.settle();
    expect([typeof written, sequencesOf(room), failed]).toEqual(['object', [1], []]);
  });
});
