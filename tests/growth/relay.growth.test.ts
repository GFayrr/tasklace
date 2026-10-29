import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  encodeRoomEntry,
  encodeRoomHeader,
  entriesAfter,
  type StoredRecord,
} from '../../relay/src/room-file.ts';
import { openRoomStore, type Room, type RoomStore } from '../../relay/src/rooms.ts';
import {
  createRelayAssembler,
  sealRelayMessage,
  type RelayCrypto,
} from '../../src/core/collaboration/relay/relay-envelope';
import { drawRelayAccess, relayKeysOf } from '../../src/core/collaboration/relay/relay-keys';
import {
  encodeRelayRecord,
  signedRecordBytes,
  type RelayRecordKind,
} from '../../src/core/collaboration/relay/relay-wire';
import { seededRandom } from '../../src/core/testing/test-crypto';
import { aesGcm, systemRandomBytes } from '../../src/main/collaboration/aes-gcm';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import {
  batched,
  BATCH_SIZE,
  CONSTANT_MAX_RATIO,
  growthRatio,
  growthRatioOf,
  LINEAR_MAX_RATIO,
  MEASURED_RUNS,
  SIZE_FACTOR,
} from './measure-growth';

const SMALL_ROOM_RECORDS = 20_000;
const LARGE_ROOM_RECORDS = SMALL_ROOM_RECORDS * SIZE_FACTOR;
const SMALL_STORED_ROOM_RECORDS = 2_000;
const LARGE_STORED_ROOM_RECORDS = SMALL_STORED_ROOM_RECORDS * SIZE_FACTOR;
const MISSING_RECORDS = 50;
const ROOMS_PER_SIZE = MEASURED_RUNS + 1;
const ROOM_ID_BYTES = 32;
const MESSAGE_ID_BYTES = 16;
const SALT_BYTES = 16;
const SIGNATURE_BYTES = 64;
const RAW_KEY_BYTES = 32;
const SMALL_MESSAGE_BYTES = 262_144;
const LARGE_MESSAGE_BYTES = SMALL_MESSAGE_BYTES * SIZE_FACTOR;
const UNLIMITED = Number.MAX_SAFE_INTEGER;
const ROOM_EXTENSION = '.room';
const STORE_TIMEOUT_MS = 120_000;
const CRYPTO: RelayCrypto = {
  aead: aesGcm,
  compression: zlibCompressor,
  randomBytes: systemRandomBytes,
};

const signer = generateKeyPairSync('ed25519');
const VERIFY_KEY = rawKeyOf(signer.publicKey);
let folder: string;
let store: RoomStore;

beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'tasklace-relay-growth-'));
});

afterAll(async () => {
  await store.settle();
  await rm(folder, { recursive: true, force: true });
});

/** Gives the raw bytes of an Ed25519 public key, the form a room keeps. */
function rawKeyOf(publicKey: KeyObject): Uint8Array {
  return new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })).slice(-RAW_KEY_BYTES);
}

/** Gives bytes that tell apart rooms or messages by a number. */
function numberedBytes(length: number, value: number): Uint8Array {
  const bytes = new Uint8Array(length);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

/** Writes a record of one chunk of one byte, signed for a room when asked. */
function recordOf(
  roomId: Uint8Array,
  number: number,
  options: { readonly kind?: RelayRecordKind; readonly covers?: number; readonly signed?: boolean },
): Uint8Array {
  const unsigned = {
    kind: options.kind ?? 'update',
    messageId: numberedBytes(MESSAGE_ID_BYTES, number),
    salt: new Uint8Array(SALT_BYTES),
    index: 0,
    count: 1,
    covers: options.covers ?? 0,
    seen: options.covers ?? 0,
    signature: new Uint8Array(SIGNATURE_BYTES),
    chunk: Uint8Array.of(number % 256),
  };
  const encoded = encodeRelayRecord(unsigned);
  if (options.signed !== true) {
    return encoded;
  }
  const signature = sign(null, signedRecordBytes(roomId, encoded), signer.privateKey);
  return encodeRelayRecord({ ...unsigned, signature: new Uint8Array(signature) });
}

/** Writes the file of a room holding a number of records, as the relay would have kept them. */
async function writeRoom(roomId: Uint8Array, count: number): Promise<void> {
  const parts = [encodeRoomHeader(VERIFY_KEY)];
  for (let seq = 1; seq <= count; seq += 1) {
    parts.push(encodeRoomEntry({ seq, record: recordOf(roomId, seq, {}) }));
  }
  const file = path.join(folder, Buffer.from(roomId).toString('hex') + ROOM_EXTENSION);
  await writeFile(file, Buffer.concat(parts));
}

/** Writes rooms of a size, one per timed run and one for warming up, numbered from a first number. */
async function writeRooms(first: number, count: number): Promise<readonly Uint8Array[]> {
  const roomIds = Array.from({ length: ROOMS_PER_SIZE }, (_, index) =>
    numberedBytes(ROOM_ID_BYTES, first + index),
  );
  for (const roomId of roomIds) {
    await writeRoom(roomId, count);
  }
  return roomIds;
}

/** Opens a store on the folder of the test, whose limits never refuse a record. */
async function openStore(): Promise<RoomStore> {
  store = await openRoomStore({
    directory: folder,
    limits: {
      maxRooms: UNLIMITED,
      maxRoomBytes: UNLIMITED,
      maxStoredBytes: UNLIMITED,
      expiryMilliseconds: UNLIMITED,
    },
    now: () => Date.now(),
    roomFailed: () => {
      throw new Error('A room of the test failed.');
    },
  });
  return store;
}

/** Opens a room of the store, failing the test when it is missing. */
async function opened(roomId: Uint8Array): Promise<Room> {
  const room = await store.open(roomId);
  if (room === null) {
    throw new Error('A room of the test did not open.');
  }
  return room;
}

/** Keeps a message of one record in a room and waits until it is written, failing the test when it is refused. */
async function append(room: Room, record: Uint8Array): Promise<void> {
  const appended = store.stage(room).take(record);
  if (appended === null || typeof appended === 'string') {
    throw new Error(`A record of the test was refused: ${String(appended)}`);
  }
  if ((await appended) === null) {
    throw new Error('A record of the test was not written.');
  }
}

/** Builds the records of a room holding a number of them, numbered from one. */
function entriesOf(count: number): readonly StoredRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    record: Uint8Array.of(index % 256),
  }));
}

describe('the relay', () => {
  it('finds what a member coming back lacks in a time that does not depend on how much the room holds', () => {
    const small = entriesOf(SMALL_ROOM_RECORDS);
    const large = entriesOf(LARGE_ROOM_RECORDS);
    const ratio = growthRatio(
      batched(BATCH_SIZE, () => entriesAfter(small, SMALL_ROOM_RECORDS - MISSING_RECORDS)),
      batched(BATCH_SIZE, () => entriesAfter(large, LARGE_ROOM_RECORDS - MISSING_RECORDS)),
    );
    expect(ratio).toBeLessThan(CONSTANT_MAX_RATIO);
  });

  it(
    'keeps a change in a time that does not depend on how much the room holds',
    { timeout: STORE_TIMEOUT_MS },
    async () => {
      const small = numberedBytes(ROOM_ID_BYTES, 1);
      const large = numberedBytes(ROOM_ID_BYTES, 2);
      await writeRoom(small, SMALL_ROOM_RECORDS);
      await writeRoom(large, LARGE_ROOM_RECORDS);
      await openStore();
      const rooms = { small: await opened(small), large: await opened(large) };
      let next = { small: SMALL_ROOM_RECORDS, large: LARGE_ROOM_RECORDS };
      /** Keeps a batch of new changes in one of the two rooms. */
      const appendBatch = (size: 'small' | 'large') => async (): Promise<void> => {
        const roomId = size === 'small' ? small : large;
        for (let count = 0; count < BATCH_SIZE; count += 1) {
          next = { ...next, [size]: next[size] + 1 };
          await append(rooms[size], recordOf(roomId, next[size], { signed: true }));
        }
      };
      const ratio = await growthRatioOf(appendBatch('small'), appendBatch('large'));
      expect(ratio).toBeLessThan(CONSTANT_MAX_RATIO);
    },
  );

  it(
    'opens a room, and empties it behind a snapshot, in a time proportional to how much it holds',
    { timeout: STORE_TIMEOUT_MS },
    async () => {
      const toOpen = {
        small: await writeRooms(100, SMALL_STORED_ROOM_RECORDS),
        large: await writeRooms(200, LARGE_STORED_ROOM_RECORDS),
      };
      const toEmpty = {
        small: await writeRooms(300, SMALL_STORED_ROOM_RECORDS),
        large: await writeRooms(400, LARGE_STORED_ROOM_RECORDS),
      };
      await openStore();
      /** Opens the room of a run from its file and lets the store forget it again. */
      const openRoom =
        (roomIds: readonly Uint8Array[]) =>
        async (index: number): Promise<void> => {
          await store.release(await opened(roomIds[index] ?? new Uint8Array()));
        };
      /** Keeps in the room of a run a snapshot covering every record before it, which empties the room. */
      const emptyRoom =
        (roomIds: readonly Uint8Array[], count: number) =>
        async (index: number): Promise<void> => {
          const roomId = roomIds[index] ?? new Uint8Array();
          const room = await opened(roomId);
          await append(
            room,
            recordOf(roomId, count + 1, { kind: 'snapshot', covers: count, signed: true }),
          );
          await store.settle();
          expect(room.entries.length).toBe(1);
        };
      const ratios = [
        await growthRatioOf(openRoom(toOpen.small), openRoom(toOpen.large)),
        await growthRatioOf(
          emptyRoom(toEmpty.small, SMALL_STORED_ROOM_RECORDS),
          emptyRoom(toEmpty.large, LARGE_STORED_ROOM_RECORDS),
        ),
      ];
      expect(ratios.map((ratio) => ratio < LINEAR_MAX_RATIO)).toEqual([true, true]);
    },
  );

  it('seals and opens a message in a time proportional to its size', () => {
    const keys = relayKeysOf(drawRelayAccess(seededRandom(91)));
    /** Seals a message of a size and opens it again from its records. */
    const sealAndOpen = (size: number) => (): void => {
      const sealed = sealRelayMessage(
        keys,
        {
          kind: 'update',
          messageId: new Uint8Array(MESSAGE_ID_BYTES),
          covers: 0,
          seen: 0,
          bytes: systemRandomBytes(size),
        },
        CRYPTO,
      );
      if (!sealed.ok) {
        throw new Error(sealed.error);
      }
      const assembler = createRelayAssembler(keys, CRYPTO);
      const opened = sealed.value.map((record, index) => assembler.take(index + 1, record));
      expect(opened.filter((result) => !result.ok || result.value !== null)).toHaveLength(1);
    };
    const ratio = growthRatio(sealAndOpen(SMALL_MESSAGE_BYTES), sealAndOpen(LARGE_MESSAGE_BYTES));
    expect(ratio).toBeLessThan(LINEAR_MAX_RATIO);
  });
});
