import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  utimes,
} from 'node:fs/promises';
import path from 'node:path';
import {
  readRelayRecord,
  signedRecordBytes,
  type RelayRecord,
  type RelayRecordKind,
} from '../../src/core/collaboration/relay/relay-wire.ts';
import {
  encodeRoomEntry,
  encodeRoomHeader,
  ENTRY_HEADER_BYTES,
  readRoomFile,
  ROOM_HEADER_BYTES,
  type StoredRecord,
} from './room-file.ts';
import { verifierOf, type Verifier } from './signature.ts';

export interface RoomLimits {
  readonly maxRooms: number;
  readonly maxRoomBytes: number;
  readonly maxStoredBytes: number;
  readonly expiryMilliseconds: number;
}

export interface Room {
  readonly name: string;
  readonly roomId: Uint8Array;
  readonly verifyKey: Uint8Array;
  readonly verify: Verifier;
  readonly entries: readonly StoredRecord[];
}

export type AppendRefusal =
  'MALFORMED' | 'BAD_SIGNATURE' | 'STALE' | 'TOO_LARGE' | 'RELAY_FULL' | 'RELAY_FAILED';

export interface Staging {
  readonly take: (
    record: Uint8Array,
  ) => AppendRefusal | Promise<readonly StoredRecord[] | null> | null;
  readonly cancel: () => void;
}

export interface RoomStore {
  readonly open: (roomId: Uint8Array) => Promise<Room | null>;
  readonly create: (
    roomId: Uint8Array,
    verifyKey: Uint8Array,
  ) => Promise<Room | 'ROOM_EXISTS' | 'RELAY_FULL'>;
  readonly stage: (room: Room) => Staging;
  readonly remove: (room: Room) => Promise<void>;
  readonly release: (room: Room) => Promise<void>;
  readonly expire: () => Promise<number>;
  readonly settle: () => Promise<void>;
}

export interface RoomStoreOptions {
  readonly directory: string;
  readonly limits: RoomLimits;
  readonly now: () => number;
  readonly roomFailed: (room: Room) => void;
}

interface Entry extends StoredRecord {
  readonly message: string;
  readonly bytes: number;
}

interface MessageState {
  readonly key: string;
  readonly kind: RelayRecordKind;
  readonly covers: number;
  readonly lastSeq: number;
}

interface LoadedRoom extends Room {
  entries: Entry[];
  readonly messages: Map<string, MessageState>;
  readonly path: string;
  bytes: number;
  reserved: number;
  floor: number;
  nextSeq: number;
  holds: number;
  writes: Promise<void>;
  failed: boolean;
}

interface Pending {
  readonly room: LoadedRoom;
  readonly first: RelayRecord;
  readonly chunks: Uint8Array[];
  readonly reserved: number;
}

interface WholeMessage {
  readonly first: RelayRecord;
  readonly entries: readonly StoredRecord[];
}

interface WholeMessages {
  readonly messages: readonly WholeMessage[];
  readonly bytes: number;
  readonly floor: number;
}

interface KnownRoom {
  bytes: number;
  touchedAt: number;
}

const ROOM_FILE = /^[0-9a-f]{64}\.room$/;
const ROOM_EXTENSION = '.room';
const TEMPORARY_EXTENSION = '.tmp';
const MILLISECONDS_PER_SECOND = 1_000;

/** Opens the rooms kept in a folder, one file per room holding its key and its records, within the number of rooms, the bytes of a room and the bytes of all of them, a message joining a room only once all its chunks came. */
export async function openRoomStore(options: RoomStoreOptions): Promise<RoomStore> {
  const { directory, limits, now } = options;
  await mkdir(directory, { recursive: true });
  const known = await scanRooms(directory);
  const loaded = new Map<string, LoadedRoom>();
  const loading = new Map<string, Promise<LoadedRoom | null>>();
  const expiring = new Set<string>();
  const releasing = new Set<Promise<void>>();
  let removing: string | null = null;
  let reservedBytes = 0;
  let storedBytes = [...known.values()].reduce((total, room) => total + room.bytes, 0);
  /** Gives the file of a room. */
  const fileOf = (name: string): string => path.join(directory, name + ROOM_EXTENSION);
  /** Changes the bytes a room holds, in the room and in the total. */
  const grow = (room: LoadedRoom, bytes: number): void => {
    room.bytes += bytes;
    storedBytes += bytes;
    const entry = known.get(room.name);
    if (entry !== undefined) {
      entry.bytes = room.bytes;
    }
  };
  /** Holds or gives back room for the chunks of a message still coming, in the room and in the total. */
  const reserve = (room: LoadedRoom, bytes: number): void => {
    room.reserved += bytes;
    reservedBytes += bytes;
  };
  /** Notes that a room was opened now, so that it does not expire, warning when its file cannot keep the date, the room then expiring sooner after a restart. */
  const touch = async (name: string): Promise<void> => {
    const time = now();
    const entry = known.get(name);
    if (entry !== undefined) {
      entry.touchedAt = time;
    }
    const seconds = time / MILLISECONDS_PER_SECOND;
    try {
      await utimes(fileOf(name), seconds, seconds);
    } catch (error) {
      console.warn(`The room ${name} could not keep the date it was opened:`, error);
    }
  };
  /** Runs a write of a room after the ones before it, giving up once one failed and telling the room failed once. */
  const queue = <T>(room: LoadedRoom, write: () => Promise<T>): Promise<T | null> => {
    const result = room.writes.then(async () => (room.failed ? null : write()));
    room.writes = result.then(
      () => undefined,
      (error: unknown) => {
        console.error(`The room ${room.name} could not be written:`, error);
        room.failed = true;
        options.roomFailed(room);
      },
    );
    return result.catch(() => null);
  };
  /** Rewrites the file of a room without the messages whose chunks all came at or before what a whole snapshot covers, which is before the snapshot itself, and raises the floor below which a record is stale. */
  const compact = async (room: LoadedRoom, snapshot: MessageState): Promise<void> => {
    room.floor = Math.max(room.floor, snapshot.covers);
    const dropped = new Set(
      [...room.messages]
        .filter(([, message]) => message.lastSeq <= snapshot.covers)
        .map(([key]) => key),
    );
    if (dropped.size === 0) {
      return;
    }
    const kept = room.entries.filter((entry) => !dropped.has(entry.message));
    await writeRoomFile(room.path, room.verifyKey, kept);
    const freed = room.entries.reduce(
      (total, entry) => (dropped.has(entry.message) ? total + entry.bytes : total),
      0,
    );
    room.entries = kept;
    dropped.forEach((key) => room.messages.delete(key));
    grow(room, -freed);
  };
  /** Loads a room from its file, setting aside a file that is not one and cutting what a crash left of a message half written, after keeping a copy of the whole file. */
  const load = async (name: string, roomId: Uint8Array): Promise<LoadedRoom | null> => {
    const file = fileOf(name);
    const bytes = new Uint8Array(await readFile(file));
    const read = readRoomFile(bytes);
    const verify = read === null ? null : verifierOf(read.verifyKey);
    const entry = known.get(name);
    if (read === null || verify === null || entry === undefined) {
      await setAside(file, now());
      storedBytes -= entry?.bytes ?? 0;
      known.delete(name);
      return null;
    }
    const whole = wholeMessages(read.entries);
    const validBytes = ROOM_HEADER_BYTES + whole.bytes;
    if (validBytes < bytes.length) {
      await cutShort(file, validBytes, bytes.length, now());
    }
    storedBytes += validBytes - entry.bytes;
    entry.bytes = validBytes;
    const room = roomOf({ name, roomId, path: file, verifyKey: read.verifyKey, verify });
    room.bytes = validBytes;
    whole.messages.forEach(({ first, entries }) => {
      keepMessage(room, first, entries);
    });
    room.floor = whole.floor;
    return room;
  };
  /** Gives the room already in memory, or loads it once however many members ask at the same time. */
  const loadOnce = async (name: string, roomId: Uint8Array): Promise<LoadedRoom | null> => {
    const ready = loaded.get(name);
    if (ready !== undefined) {
      return ready;
    }
    const pending = loading.get(name) ?? load(name, roomId);
    loading.set(name, pending);
    try {
      const room = await pending;
      if (room !== null) {
        loaded.set(name, room);
      }
      return room;
    } finally {
      loading.delete(name);
    }
  };
  /** Lets go of a room a member held, and once nobody holds it, forgets it from memory after its writes, noting when it was last opened. */
  const release = async (room: Room): Promise<void> => {
    const target = loaded.get(room.name);
    if (target === undefined) {
      return;
    }
    target.holds -= 1;
    await target.writes;
    if (target.holds > 0 || loaded.get(room.name) !== target) {
      return;
    }
    loaded.delete(room.name);
    if (!target.failed) {
      await touch(room.name);
    }
  };
  /** Tells why a message cannot be placed in a room as it is now: a message already there, a snapshot covering what is not there yet, or a record older than what a snapshot freed, its author having seen less than the room dropped since. */
  const placeRefusal = (room: LoadedRoom, record: RelayRecord): AppendRefusal | null => {
    if (room.messages.has(messageKeyOf(record))) {
      return 'MALFORMED';
    }
    if (record.kind === 'snapshot' && record.covers >= room.nextSeq) {
      return 'MALFORMED';
    }
    return record.seen < room.floor ? 'STALE' : null;
  };
  /** Starts a message from its first chunk, holding room for every chunk it announces, none being larger than the first, a snapshot having one whole room more since it replaces what it covers. */
  const begin = (room: LoadedRoom, record: RelayRecord, size: number): Pending | AppendRefusal => {
    const refusal = record.index === 0 ? placeRefusal(room, record) : 'MALFORMED';
    if (refusal !== null) {
      return refusal;
    }
    const needed = record.count * (ENTRY_HEADER_BYTES + size);
    const headroom = record.kind === 'snapshot' ? limits.maxRoomBytes : 0;
    if (room.bytes + room.reserved + needed > limits.maxRoomBytes + headroom) {
      return 'TOO_LARGE';
    }
    if (storedBytes + reservedBytes + needed > limits.maxStoredBytes + headroom) {
      return 'RELAY_FULL';
    }
    reserve(room, needed);
    return { room, first: record, chunks: [], reserved: needed };
  };
  /** Keeps a message once all its chunks came: gives them their sequences and writes them together, passing them on once on disk, and frees what a snapshot covers. */
  const commit = (pending: Pending): AppendRefusal | Promise<readonly StoredRecord[] | null> => {
    const { room, first } = pending;
    const refusal = placeRefusal(room, first);
    if (refusal !== null) {
      return refusal;
    }
    const entries = pending.chunks.map((record, index) => ({ seq: room.nextSeq + index, record }));
    const message = noteMessage(room, first, entries);
    grow(room, sizeOfEntries(entries));
    const written = queue(room, async () => {
      await appendDurably(room.path, joinedEntries(entries));
      entries.forEach((entry) => {
        store(room, entry, message.key);
      });
      return entries;
    });
    if (message.kind === 'snapshot') {
      void queue(room, () => compact(room, message));
    }
    return written;
  };
  /** Takes a chunk signed with the key of a room into the message it continues, or starts a message from it. */
  const advance = (
    room: LoadedRoom,
    pending: Pending | null,
    bytes: Uint8Array,
  ): Pending | AppendRefusal => {
    const record = readSigned(room, bytes);
    if (typeof record === 'string') {
      return record;
    }
    return pending === null ? begin(room, record, bytes.length) : follow(pending, record);
  };
  /** Removes a room nobody holds that nobody opened for longer than the relay keeps rooms, unless a member opened it meanwhile, telling whether it was removed. */
  const expireOne = async (name: string, time: number): Promise<boolean> => {
    const room = known.get(name);
    const stillStale =
      room !== undefined &&
      expiring.has(name) &&
      !loaded.has(name) &&
      !loading.has(name) &&
      time - room.touchedAt > limits.expiryMilliseconds;
    expiring.delete(name);
    if (!stillStale) {
      return false;
    }
    removing = name;
    try {
      await rm(fileOf(name), { force: true });
    } finally {
      removing = null;
    }
    known.delete(name);
    storedBytes -= room.bytes;
    return true;
  };
  return {
    open: async (roomId) => {
      const name = Buffer.from(roomId).toString('hex');
      if (!known.has(name) || removing === name) {
        return null;
      }
      expiring.delete(name);
      const room = await loadOnce(name, roomId);
      if (room === null) {
        return null;
      }
      room.holds += 1;
      await touch(name);
      return room;
    },
    create: async (roomId, verifyKey) => {
      const name = Buffer.from(roomId).toString('hex');
      const verify = verifierOf(verifyKey);
      if (known.has(name)) {
        return 'ROOM_EXISTS';
      }
      if (verify === null || known.size >= limits.maxRooms) {
        return 'RELAY_FULL';
      }
      if (storedBytes + ROOM_HEADER_BYTES > limits.maxStoredBytes) {
        return 'RELAY_FULL';
      }
      known.set(name, { bytes: ROOM_HEADER_BYTES, touchedAt: now() });
      storedBytes += ROOM_HEADER_BYTES;
      const file = fileOf(name);
      try {
        await writeNewFile(file, encodeRoomHeader(verifyKey));
      } catch (error) {
        known.delete(name);
        storedBytes -= ROOM_HEADER_BYTES;
        throw error;
      }
      const room = roomOf({ name, roomId, path: file, verifyKey, verify });
      room.bytes = ROOM_HEADER_BYTES;
      room.holds = 1;
      loaded.set(name, room);
      return room;
    },
    stage: (room) => {
      let pending: Pending | null = null;
      /** Gives back the room a message still coming held. */
      const cancel = (): void => {
        if (pending !== null) {
          reserve(pending.room, -pending.reserved);
        }
        pending = null;
      };
      return {
        take: (bytes) => {
          const target = loaded.get(room.name);
          const next =
            target === undefined || target.failed
              ? 'RELAY_FAILED'
              : advance(target, pending, bytes);
          if (typeof next === 'string') {
            cancel();
            return next;
          }
          next.chunks.push(bytes);
          pending = next;
          if (next.chunks.length < next.first.count) {
            return null;
          }
          cancel();
          return commit(next);
        },
        cancel,
      };
    },
    remove: async (room) => {
      const target = loaded.get(room.name);
      if (target === undefined) {
        return;
      }
      target.failed = true;
      await target.writes;
      await rm(target.path, { force: true });
      loaded.delete(room.name);
      known.delete(room.name);
      storedBytes -= target.bytes;
    },
    release: (room) => {
      const released = release(room);
      releasing.add(released);
      /** Forgets a release once it ended. */
      const forget = (): void => {
        releasing.delete(released);
      };
      released.then(forget, forget);
      return released;
    },
    expire: async () => {
      const time = now();
      const stale = [...known]
        .filter(([, room]) => time - room.touchedAt > limits.expiryMilliseconds)
        .map(([name]) => name);
      stale.forEach((name) => {
        expiring.add(name);
      });
      let removed = 0;
      for (const name of stale) {
        const done = await expireOne(name, time).catch((error: unknown) => {
          console.error(`The room ${name} nobody opens could not be removed:`, error);
          return false;
        });
        removed += done ? 1 : 0;
      }
      return removed;
    },
    settle: async () => {
      await Promise.all([...loaded.values()].map((room) => room.writes));
      await Promise.allSettled([...releasing]);
    },
  };
}

/** Makes the state of a room held in memory, with no record yet. */
function roomOf(
  room: Pick<LoadedRoom, 'name' | 'roomId' | 'path' | 'verifyKey' | 'verify'>,
): LoadedRoom {
  return {
    ...room,
    entries: [],
    messages: new Map(),
    bytes: 0,
    reserved: 0,
    floor: 0,
    nextSeq: 1,
    holds: 0,
    writes: Promise.resolve(),
    failed: false,
  };
}

/** Reads a chunk sent to a room as a record of the format signed with the key of the room, or tells why it is not one. */
function readSigned(room: LoadedRoom, bytes: Uint8Array): RelayRecord | AppendRefusal {
  const record = readRelayRecord(bytes);
  if (record === null) {
    return 'MALFORMED';
  }
  return room.verify(signedRecordBytes(room.roomId, bytes), record.signature)
    ? record
    : 'BAD_SIGNATURE';
}

/** Takes the next chunk of a message still coming, refusing a chunk of another message or out of its place, as a member sends the chunks of a message one after another. */
function follow(pending: Pending, record: RelayRecord): Pending | AppendRefusal {
  return isChunkOf(pending.first, record) && record.index === pending.chunks.length
    ? pending
    : 'MALFORMED';
}

/** Notes a message whose chunks get their sequences in a room, and gives what the room knows of it. */
function noteMessage(
  room: LoadedRoom,
  first: RelayRecord,
  entries: readonly StoredRecord[],
): MessageState {
  const message: MessageState = {
    key: messageKeyOf(first),
    kind: first.kind,
    covers: first.covers,
    lastSeq: entries.at(-1)?.seq ?? room.nextSeq,
  };
  room.messages.set(message.key, message);
  room.nextSeq = message.lastSeq + 1;
  return message;
}

/** Notes a whole message read from the file of a room and adds its chunks to the records the room passes on. */
function keepMessage(room: LoadedRoom, first: RelayRecord, entries: readonly StoredRecord[]): void {
  const message = noteMessage(room, first, entries);
  entries.forEach((entry) => {
    store(room, entry, message.key);
  });
}

/** Adds a record written to the file of a room to the records it passes on. */
function store(room: LoadedRoom, stored: StoredRecord, message: string): void {
  room.entries.push({ ...stored, message, bytes: ENTRY_HEADER_BYTES + stored.record.length });
}

/** Gives the bytes some records take in the file of a room. */
function sizeOfEntries(entries: readonly StoredRecord[]): number {
  return entries.reduce((total, entry) => total + ENTRY_HEADER_BYTES + entry.record.length, 0);
}

/** Writes some records as they are kept in the file of a room, one after another. */
function joinedEntries(entries: readonly StoredRecord[]): Uint8Array {
  return new Uint8Array(Buffer.concat(entries.map(encodeRoomEntry)));
}

/** Keeps the whole messages at the start of the records read from the file of a room, up to the first one a crash left without all its chunks, with the bytes they take and the highest sequence a snapshot among them covers. */
function wholeMessages(entries: readonly StoredRecord[]): WholeMessages {
  const messages: WholeMessage[] = [];
  let chunks: StoredRecord[] = [];
  let first: RelayRecord | null = null;
  for (const entry of entries) {
    const record = readRelayRecord(entry.record);
    first = record !== null && record.index === 0 && chunks.length === 0 ? record : first;
    if (
      record === null ||
      first === null ||
      !isChunkOf(first, record) ||
      record.index !== chunks.length
    ) {
      break;
    }
    chunks.push(entry);
    if (chunks.length === record.count) {
      messages.push({ first, entries: chunks });
      chunks = [];
      first = null;
    }
  }
  return {
    messages,
    bytes: messages.reduce((total, message) => total + sizeOfEntries(message.entries), 0),
    floor: messages.reduce(
      (floor, message) =>
        message.first.kind === 'snapshot' ? Math.max(floor, message.first.covers) : floor,
      0,
    ),
  };
}

/** Names the message a record belongs to by its identifier and the salt of its key, a message sent again being sealed anew. */
function messageKeyOf(record: RelayRecord): string {
  return Buffer.from(record.messageId).toString('hex') + Buffer.from(record.salt).toString('hex');
}

/** Tells whether a chunk belongs to the message a first chunk started, telling the same of it. */
function isChunkOf(first: RelayRecord, record: RelayRecord): boolean {
  return (
    messageKeyOf(first) === messageKeyOf(record) &&
    first.kind === record.kind &&
    first.count === record.count &&
    first.covers === record.covers &&
    first.seen === record.seen
  );
}

/** Lists the rooms kept in a folder with their size and when they were last opened, removing what an interrupted rewrite left. */
async function scanRooms(directory: string): Promise<Map<string, KnownRoom>> {
  const rooms = new Map<string, KnownRoom>();
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    if (name.endsWith(TEMPORARY_EXTENSION)) {
      await rm(file, { force: true });
    }
    if (ROOM_FILE.test(name)) {
      const found = await stat(file);
      rooms.set(name.slice(0, -ROOM_EXTENSION.length), {
        bytes: found.size,
        touchedAt: found.mtimeMs,
      });
    }
  }
  return rooms;
}

/** Writes the file of a room again with only some of its records, through a temporary file so that a crash never leaves it half written. */
async function writeRoomFile(
  file: string,
  verifyKey: Uint8Array,
  entries: readonly StoredRecord[],
): Promise<void> {
  const temporary = file + TEMPORARY_EXTENSION;
  const handle = await open(temporary, 'w');
  try {
    await handle.write(encodeRoomHeader(verifyKey));
    for (const entry of entries) {
      await handle.write(encodeRoomEntry(entry));
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

/** Adds records at the end of the file of a room and waits until the disk holds them, so that a relay that stops at once never gives their sequences again to other records. */
async function appendDurably(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, 'a');
  try {
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Cuts the end of the file of a room that a crash left with a message half written, keeping a copy of the whole file aside first. */
async function cutShort(
  file: string,
  validBytes: number,
  total: number,
  time: number,
): Promise<void> {
  const copy = `${file}.damaged-${String(time)}`;
  await copyFile(file, copy);
  console.warn(
    `The room file ${file} ended with ${String(total - validBytes)} bytes of a message cut short, which were dropped; the whole file was copied to ${copy}.`,
  );
  await truncate(file, validBytes);
}

/** Writes the file of a new room, failing if one is already there. */
async function writeNewFile(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, 'wx');
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
}

/** Moves a file that is not the file of a room aside, under a name the relay never reads again. */
async function setAside(file: string, time: number): Promise<void> {
  console.error(`${file} is not the file of a room and was set aside.`);
  await rename(file, `${file}.damaged-${String(time)}`);
}
