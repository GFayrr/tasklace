import {
  MAX_RELAY_RECORD_BYTES,
  readRelayRecord,
  VERIFY_KEY_BYTES,
} from '../../src/core/collaboration/relay/relay-wire.ts';

export interface StoredRecord {
  readonly seq: number;
  readonly record: Uint8Array;
}

export interface RoomFile {
  readonly verifyKey: Uint8Array;
  readonly entries: readonly StoredRecord[];
  readonly validBytes: number;
}

const MAGIC = new TextEncoder().encode('TLRY');
const FILE_VERSION = 2;
const VERSION_OFFSET = MAGIC.length;
const KEY_OFFSET = VERSION_OFFSET + 1;
export const ROOM_HEADER_BYTES = KEY_OFFSET + VERIFY_KEY_BYTES;
const SEQUENCE_BYTES = 8;
const LENGTH_BYTES = 4;
export const ENTRY_HEADER_BYTES = SEQUENCE_BYTES + LENGTH_BYTES;

/** Writes the start of the file of a room: a mark, the version of the format and the key that checks its records. */
export function encodeRoomHeader(verifyKey: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(ROOM_HEADER_BYTES);
  bytes.set(MAGIC);
  bytes[VERSION_OFFSET] = FILE_VERSION;
  bytes.set(verifyKey, KEY_OFFSET);
  return bytes;
}

/** Writes one record kept in the file of a room, after its sequence and its length. */
export function encodeRoomEntry(entry: StoredRecord): Uint8Array {
  const bytes = new Uint8Array(ENTRY_HEADER_BYTES + entry.record.length);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(entry.seq));
  view.setUint32(SEQUENCE_BYTES, entry.record.length);
  bytes.set(entry.record, ENTRY_HEADER_BYTES);
  return bytes;
}

/** Reads the file of a room, returning null when its start is not one, and keeping the records up to the first one cut short or out of order, as a crash in the middle of a write leaves it. */
export function readRoomFile(bytes: Uint8Array): RoomFile | null {
  if (!hasRoomHeader(bytes)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: StoredRecord[] = [];
  let at = ROOM_HEADER_BYTES;
  let lastSeq = 0;
  while (bytes.length - at >= ENTRY_HEADER_BYTES) {
    const seq = Number(view.getBigUint64(at));
    const length = view.getUint32(at + SEQUENCE_BYTES);
    const end = at + ENTRY_HEADER_BYTES + length;
    if (seq <= lastSeq || !Number.isSafeInteger(seq) || length > MAX_RELAY_RECORD_BYTES) {
      break;
    }
    const record = end > bytes.length ? null : bytes.slice(at + ENTRY_HEADER_BYTES, end);
    if (record === null || readRelayRecord(record) === null) {
      break;
    }
    entries.push({ seq, record });
    lastSeq = seq;
    at = end;
  }
  return { verifyKey: bytes.slice(KEY_OFFSET, ROOM_HEADER_BYTES), entries, validBytes: at };
}

/** Tells whether bytes start with the mark and version of the file of a room. */
function hasRoomHeader(bytes: Uint8Array): boolean {
  return (
    bytes.length >= ROOM_HEADER_BYTES &&
    MAGIC.every((byte, index) => bytes[index] === byte) &&
    bytes[VERSION_OFFSET] === FILE_VERSION
  );
}

/** Gives the records of a room that come after a sequence, the ones a member who holds the records up to it still lacks, found by halving since a room keeps its records in the order of their sequences. */
export function entriesAfter<Entry extends StoredRecord>(
  entries: readonly Entry[],
  since: number,
): readonly Entry[] {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((entries[middle]?.seq ?? Number.POSITIVE_INFINITY) > since) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return entries.slice(low);
}
