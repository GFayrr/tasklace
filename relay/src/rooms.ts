import {
  appendFile,
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

export type AppendRefusal = 'MALFORMED' | 'BAD_SIGNATURE' | 'TOO_LARGE' | 'RELAY_FULL';

export interface RoomStore {
  readonly open: (roomId: Uint8Array) => Promise<Room | null>;
  readonly create: (
    roomId: Uint8Array,
    verifyKey: Uint8Array,
  ) => Promise<Room | 'ROOM_EXISTS' | 'RELAY_FULL'>;
  readonly append: (room: Room, record: Uint8Array) => AppendRefusal | Promise<StoredRecord | null>;
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
  readonly count: number;
  readonly covers: number;
  readonly indexes: Set<number>;
  readonly firstSeq: number;
  lastSeq: number;
}

interface LoadedRoom extends Room {
  entries: Entry[];
  readonly messages: Map<string, MessageState>;
  readonly path: string;
  bytes: number;
  nextSeq: number;
  holds: number;
  writes: Promise<void>;
  failed: boolean;
}

interface KnownRoom {
  bytes: number;
  touchedAt: number;
}

const ROOM_FILE = /^[0-9a-f]{64}\.room$/;
const ROOM_EXTENSION = '.room';
const TEMPORARY_EXTENSION = '.tmp';
const MILLISECONDS_PER_SECOND = 1_000;

/** Opens the rooms kept in a folder, one file per room holding its key and its records, within the number of rooms, the bytes of a room and the bytes of all of them. */
export async function openRoomStore(options: RoomStoreOptions): Promise<RoomStore> {
  const { directory, limits, now } = options;
  await mkdir(directory, { recursive: true });
  const known = await scanRooms(directory);
  const loaded = new Map<string, LoadedRoom>();
  const loading = new Map<string, Promise<LoadedRoom | null>>();
  const expiring = new Set<string>();
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
  /** Rewrites the file of a room without the messages whose chunks all came at or before the sequence a whole snapshot covers, which is before the snapshot itself since a snapshot covering more is refused. */
  const compact = async (room: LoadedRoom, snapshot: MessageState): Promise<void> => {
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
  /** Loads a room from its file, setting aside a file that is not one and cutting a record a crash left half written. */
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
    if (read.validBytes < bytes.length) {
      console.warn(`The room ${name} ended with a record cut short, which was dropped.`);
      await truncate(file, read.validBytes);
    }
    storedBytes += read.validBytes - entry.bytes;
    entry.bytes = read.validBytes;
    const room = roomOf({ name, roomId, path: file, verifyKey: read.verifyKey, verify });
    room.bytes = read.validBytes;
    read.entries.forEach((stored) => {
      const record = readRelayRecord(stored.record);
      if (record !== null) {
        store(room, stored, track(room, stored.seq, record));
      }
    });
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
  /** Tells why a record cannot join a room: another chunk of a message under the same place, a snapshot covering what is not there yet, or a room or a relay too full, a snapshot having the room of a whole room more to replace what it covers. */
  const refusalOf = (room: LoadedRoom, record: RelayRecord, size: number): AppendRefusal | null => {
    const message = room.messages.get(messageKeyOf(record));
    const clashes =
      message !== undefined &&
      (!isSameMessage(message, record) || message.indexes.has(record.index));
    if (clashes || (record.kind === 'snapshot' && record.covers >= room.nextSeq)) {
      return 'MALFORMED';
    }
    const headroom = record.kind === 'snapshot' ? limits.maxRoomBytes : 0;
    if (room.bytes + size > limits.maxRoomBytes + headroom) {
      return 'TOO_LARGE';
    }
    return storedBytes + size > limits.maxStoredBytes + headroom ? 'RELAY_FULL' : null;
  };
  return {
    open: async (roomId) => {
      const name = Buffer.from(roomId).toString('hex');
      if (!known.has(name) || expiring.has(name)) {
        return null;
      }
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
    append: (room, bytes) => {
      const target = loaded.get(room.name);
      if (target === undefined || target.failed) {
        return 'RELAY_FULL';
      }
      const record = readRelayRecord(bytes);
      if (record === null) {
        return 'MALFORMED';
      }
      if (!target.verify(signedRecordBytes(target.roomId, bytes), record.signature)) {
        return 'BAD_SIGNATURE';
      }
      const refusal = refusalOf(target, record, ENTRY_HEADER_BYTES + bytes.length);
      if (refusal !== null) {
        return refusal;
      }
      const entry = { seq: target.nextSeq, record: bytes };
      const message = track(target, entry.seq, record);
      grow(target, ENTRY_HEADER_BYTES + bytes.length);
      const written = queue(target, async () => {
        await appendFile(target.path, encodeRoomEntry(entry));
        store(target, entry, message);
        return entry;
      });
      if (message.kind === 'snapshot' && message.indexes.size === message.count) {
        void queue(target, () => compact(target, message));
      }
      return written;
    },
    remove: async (room) => {
      const target = loaded.get(room.name);
      if (target === undefined) {
        return;
      }
      target.failed = true;
      loaded.delete(room.name);
      known.delete(room.name);
      storedBytes -= target.bytes;
      await target.writes;
      await rm(target.path, { force: true });
    },
    release: async (room) => {
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
    },
    expire: async () => {
      const time = now();
      const stale = [...known].filter(
        ([name, room]) =>
          !loaded.has(name) &&
          !loading.has(name) &&
          time - room.touchedAt > limits.expiryMilliseconds,
      );
      for (const [name, room] of stale) {
        expiring.add(name);
        try {
          await rm(fileOf(name), { force: true });
        } finally {
          expiring.delete(name);
        }
        known.delete(name);
        storedBytes -= room.bytes;
      }
      return stale.length;
    },
    settle: async () => {
      await Promise.all([...loaded.values()].map((room) => room.writes));
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
    nextSeq: 1,
    holds: 0,
    writes: Promise.resolve(),
    failed: false,
  };
}

/** Notes a record under the message it belongs to as soon as the relay takes it, and gives that message. */
function track(room: LoadedRoom, seq: number, record: RelayRecord): MessageState {
  const key = messageKeyOf(record);
  const message = room.messages.get(key) ?? {
    key,
    kind: record.kind,
    count: record.count,
    covers: record.covers,
    indexes: new Set<number>(),
    firstSeq: seq,
    lastSeq: seq,
  };
  message.indexes.add(record.index);
  message.lastSeq = seq;
  room.messages.set(key, message);
  room.nextSeq = seq + 1;
  return message;
}

/** Adds a record written to the file of a room to the records it passes on. */
function store(room: LoadedRoom, stored: StoredRecord, message: MessageState): void {
  room.entries.push({
    ...stored,
    message: message.key,
    bytes: ENTRY_HEADER_BYTES + stored.record.length,
  });
}

/** Names the message a record belongs to by its identifier and the salt of its key, a message sent again being sealed anew. */
function messageKeyOf(record: RelayRecord): string {
  return Buffer.from(record.messageId).toString('hex') + Buffer.from(record.salt).toString('hex');
}

/** Tells whether a chunk tells the same of its message as the chunks before it. */
function isSameMessage(message: MessageState, record: RelayRecord): boolean {
  return (
    message.kind === record.kind &&
    message.count === record.count &&
    message.covers === record.covers
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
