import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  encodeRelayRecord,
  MAX_RELAY_RECORD_BYTES,
} from '../../src/core/collaboration/relay/relay-wire.ts';
import {
  encodeRoomEntry,
  encodeRoomHeader,
  ENTRY_HEADER_BYTES,
  entriesAfter,
  readRoomFile,
  ROOM_HEADER_BYTES,
  type StoredRecord,
} from './room-file.ts';

const KEY = new Uint8Array(32).fill(9);

/** Makes a record holding a chunk of one byte. */
function recordOf(byte: number): Uint8Array {
  return encodeRelayRecord({
    kind: 'update',
    messageId: new Uint8Array(16).fill(byte),
    salt: new Uint8Array(16),
    index: 0,
    count: 1,
    covers: 0,
    seen: 0,
    signature: new Uint8Array(64),
    chunk: Uint8Array.of(byte),
  });
}

/** Joins the parts of a file. */
function fileOf(parts: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

describe('the file of a room', () => {
  it('reads back its key and its records in order', () => {
    const entries = [
      { seq: 1, record: recordOf(1) },
      { seq: 5, record: recordOf(2) },
    ];
    const bytes = fileOf([encodeRoomHeader(KEY), ...entries.map(encodeRoomEntry)]);
    expect(readRoomFile(bytes)).toEqual({ verifyKey: KEY, entries, validBytes: bytes.length });
  });

  it('keeps the records before one a crash cut short, telling where the good part ends', () => {
    const good = fileOf([encodeRoomHeader(KEY), encodeRoomEntry({ seq: 1, record: recordOf(1) })]);
    const cut = encodeRoomEntry({ seq: 2, record: recordOf(2) });
    const cases = [cut.subarray(0, ENTRY_HEADER_BYTES - 1), cut.subarray(0, cut.length - 1)].map(
      (tail) => readRoomFile(fileOf([good, tail]))?.validBytes,
    );
    expect(cases).toEqual([good.length, good.length]);
  });

  it('stops at a record out of order, too long, unsafe or that is not a record', () => {
    const header = encodeRoomHeader(KEY);
    const first = encodeRoomEntry({ seq: 3, record: recordOf(1) });
    const tooLong = new Uint8Array(ENTRY_HEADER_BYTES);
    new DataView(tooLong.buffer).setBigUint64(0, 4n);
    new DataView(tooLong.buffer).setUint32(8, MAX_RELAY_RECORD_BYTES + 1);
    const unsafe = encodeRoomEntry({ seq: 4, record: recordOf(2) });
    new DataView(unsafe.buffer).setBigUint64(0, 2n ** 60n);
    const tails = [
      encodeRoomEntry({ seq: 3, record: recordOf(2) }),
      tooLong,
      unsafe,
      encodeRoomEntry({ seq: 4, record: Uint8Array.of(7, 7) }),
    ];
    expect(
      tails.map((tail) => readRoomFile(fileOf([header, first, tail]))?.entries.length),
    ).toEqual([1, 1, 1, 1]);
  });

  it('refuses a file without the mark of a room, of the version before the records told what their author had seen or of a newer one, or too short to hold its key', () => {
    const header = encodeRoomHeader(KEY);
    const otherMark = header.slice();
    otherMark[0] = 0;
    const olderVersion = header.slice();
    olderVersion[4] = 1;
    const newerVersion = header.slice();
    newerVersion[4] = 3;
    expect(
      [otherMark, olderVersion, newerVersion, header.subarray(0, ROOM_HEADER_BYTES - 1)].map(
        readRoomFile,
      ),
    ).toEqual([null, null, null, null]);
  });
});

/** Gives records numbered by the sequences given, in their order. */
function numbered(sequences: readonly number[]): readonly StoredRecord[] {
  return sequences.map((seq) => ({ seq, record: recordOf(seq % 256) }));
}

describe('the records a member coming back lacks', () => {
  it('are those after the sequence it holds, with gaps a snapshot left, none, or all', () => {
    const room = numbered([2, 3, 7, 8, 12]);
    expect(
      [-1, 0, 2, 4, 7, 11, 12, 99].map((since) => entriesAfter(room, since).map(({ seq }) => seq)),
    ).toEqual([
      [2, 3, 7, 8, 12],
      [2, 3, 7, 8, 12],
      [3, 7, 8, 12],
      [7, 8, 12],
      [8, 12],
      [12],
      [],
      [],
    ]);
    expect(entriesAfter([], 0)).toEqual([]);
  });

  it('are the same as when every record of the room is looked at', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 1_000 }), { maxLength: 64 }),
        fc.integer({ min: -1, max: 1_001 }),
        (sequences, since) => {
          const room = numbered([...sequences].sort((left, right) => left - right));
          expect(entriesAfter(room, since)).toEqual(room.filter(({ seq }) => seq > since));
        },
      ),
    );
  });
});
