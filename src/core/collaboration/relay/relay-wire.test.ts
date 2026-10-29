import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_RELAY_CHUNKS,
  MAX_RELAY_FRAME_BYTES,
  MAX_RELAY_MEMBERS,
  MAX_RELAY_PRESENCE_BYTES,
  MAX_RELAY_RECORD_BYTES,
  MAX_RELAY_SEQUENCE,
  RECORD_SIGNATURE_OFFSET,
  RELAY_CHUNK_BYTES,
  RELAY_WIRE_VERSION,
  encodeClientFrame,
  encodeRelayFrame,
  encodeRelayRecord,
  readClientFrame,
  readRelayFrame,
  readRelayRecord,
  signedCloseBytes,
  signedCreateBytes,
  signedRecordBytes,
  type ClientFrame,
  type RelayFrame,
  coveredSequence,
  type RelayRecord,
  type RelayRecordKind,
} from './relay-wire';

const ROOM = new Uint8Array(32).fill(3);
const OTHER_ROOM = new Uint8Array(32).fill(4);
const RECORD: RelayRecord = {
  kind: 'snapshot',
  messageId: new Uint8Array(16).fill(1),
  salt: new Uint8Array(16).fill(2),
  index: 1,
  count: 3,
  covers: 41,
  seen: 43,
  signature: new Uint8Array(64).fill(9),
  chunk: Uint8Array.of(5, 6, 7),
};
const HEADER_BYTES = 2;
const INDEX_OFFSET = 33;
const COUNT_OFFSET = 35;
const COVERS_OFFSET = 37;
const SEEN_OFFSET = 45;

/** Writes a record with some fields changed, what it covers following its kind. */
function recordWith(
  change: Partial<Omit<RelayRecord, 'kind' | 'covers'>> & {
    readonly kind?: RelayRecordKind;
    readonly covers?: number;
  },
): Uint8Array {
  const merged = { ...RECORD, ...change };
  return encodeRelayRecord({ ...merged, ...coveredSequence(merged.kind, merged.covers) });
}

/** Changes the count of chunks a record tells, to forge what no encoder writes. */
function withCount(bytes: Uint8Array, count: number): Uint8Array {
  const changed = Uint8Array.from(bytes);
  new DataView(changed.buffer).setUint16(COUNT_OFFSET, count);
  return changed;
}

/** Changes the place of the chunk of a record, to forge what no encoder writes. */
function withIndex(bytes: Uint8Array, index: number): Uint8Array {
  const changed = Uint8Array.from(bytes);
  new DataView(changed.buffer).setUint16(INDEX_OFFSET, index);
  return changed;
}

/** Changes eight bytes of a record to a number, to forge what no encoder writes. */
function withNumber(bytes: Uint8Array, offset: number, value: bigint): Uint8Array {
  const changed = Uint8Array.from(bytes);
  new DataView(changed.buffer).setBigUint64(offset, value);
  return changed;
}

/** Writes a frame from a version, a type code and content, to forge what no encoder writes. */
function rawFrame(
  type: number,
  content: readonly number[],
  version = RELAY_WIRE_VERSION,
): Uint8Array {
  return Uint8Array.of(version, type, ...content);
}

/** Changes eight bytes of a record to a large number, which no encoder of a safe integer writes. */
function withHugeNumber(bytes: Uint8Array, offset: number): Uint8Array {
  const changed = Uint8Array.from(bytes);
  new DataView(changed.buffer).setBigUint64(offset, BigInt(MAX_RELAY_SEQUENCE) + 1n);
  return changed;
}

describe('the records the relay keeps', () => {
  it('reads back a record as it was written, its fields in their places', () => {
    const bytes = encodeRelayRecord(RECORD);
    expect([readRelayRecord(bytes), bytes.length, RECORD_SIGNATURE_OFFSET]).toEqual([
      RECORD,
      RECORD_SIGNATURE_OFFSET + 64 + 3,
      53,
    ]);
  });

  it('holds a chunk of one mebibyte at most', () => {
    const largest = recordWith({ chunk: new Uint8Array(RELAY_CHUNK_BYTES) });
    expect([
      largest.length,
      readRelayRecord(largest)?.chunk.length,
      readRelayRecord(Uint8Array.from([...largest, 0])),
    ]).toEqual([MAX_RELAY_RECORD_BYTES, RELAY_CHUNK_BYTES, null]);
  });

  it('refuses a record too short, of an unknown kind, out of place, of no or too many chunks, covering a sequence it may not, or more than its author had seen', () => {
    const unknownKind = encodeRelayRecord(RECORD);
    unknownKind[0] = 3;
    const noKind = encodeRelayRecord(RECORD);
    noKind[0] = 0;
    const tooManyChunks = encodeRelayRecord(RECORD);
    new DataView(tooManyChunks.buffer).setUint16(COUNT_OFFSET, MAX_RELAY_CHUNKS + 1);
    expect(
      [
        encodeRelayRecord(RECORD).subarray(0, RECORD_SIGNATURE_OFFSET + 63),
        unknownKind,
        noKind,
        withCount(recordWith({ index: 0 }), 0),
        tooManyChunks,
        withIndex(recordWith({}), 3),
        withNumber(recordWith({ kind: 'update', seen: 1 }), COVERS_OFFSET, 1n),
        withHugeNumber(encodeRelayRecord(RECORD), COVERS_OFFSET),
        withHugeNumber(encodeRelayRecord(RECORD), SEEN_OFFSET),
        recordWith({ seen: 40 }),
      ].map(readRelayRecord),
    ).toEqual([null, null, null, null, null, null, null, null, null, null]);
  });

  it('refuses to write a record whose fields do not have the lengths of the format or whose chunk is out of place', () => {
    expect(
      [
        { messageId: new Uint8Array(17) },
        { salt: new Uint8Array(15) },
        { signature: new Uint8Array(63) },
        { chunk: new Uint8Array(RELAY_CHUNK_BYTES + 1) },
        { count: 0, index: 0 },
        { count: MAX_RELAY_CHUNKS + 1 },
        { index: 3 },
      ].map((change) => {
        try {
          return recordWith(change).length;
        } catch (error) {
          return error instanceof RangeError ? error.message : error;
        }
      }),
    ).toEqual(
      Array.from(
        { length: 7 },
        () => 'A record has a field of the wrong length or a chunk out of place.',
      ),
    );
  });

  it('accepts as many chunks as a message may have, and a record with an empty chunk', () => {
    expect([
      readRelayRecord(recordWith({ count: MAX_RELAY_CHUNKS, index: MAX_RELAY_CHUNKS - 1 }))?.count,
      readRelayRecord(recordWith({ chunk: new Uint8Array() }))?.chunk.length,
    ]).toEqual([MAX_RELAY_CHUNKS, 0]);
  });

  it('signs every byte of a record but its signature, with its room, so that a change of any field or room changes what is signed', () => {
    const signed = signedRecordBytes(ROOM, encodeRelayRecord(RECORD));
    const otherSignature = signedRecordBytes(ROOM, recordWith({ signature: new Uint8Array(64) }));
    const changes = [
      signedRecordBytes(OTHER_ROOM, encodeRelayRecord(RECORD)),
      signedRecordBytes(ROOM, recordWith({ kind: 'update', covers: 0 })),
      signedRecordBytes(ROOM, recordWith({ messageId: new Uint8Array(16) })),
      signedRecordBytes(ROOM, recordWith({ salt: new Uint8Array(16) })),
      signedRecordBytes(ROOM, recordWith({ index: 2 })),
      signedRecordBytes(ROOM, recordWith({ count: 4 })),
      signedRecordBytes(ROOM, recordWith({ covers: 40 })),
      signedRecordBytes(ROOM, recordWith({ seen: 44 })),
      signedRecordBytes(ROOM, recordWith({ chunk: Uint8Array.of(5, 6, 8) })),
    ];
    expect([otherSignature, ...changes.map((bytes) => bytesEqual(bytes, signed))]).toEqual([
      signed,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('signs the creation and the closing of a room apart from records and from each other', () => {
    const key = new Uint8Array(32).fill(8);
    expect([
      bytesEqual(signedCreateBytes(ROOM, key), signedCreateBytes(OTHER_ROOM, key)),
      bytesEqual(signedCloseBytes(ROOM), signedCloseBytes(OTHER_ROOM)),
      new TextDecoder().decode(signedCreateBytes(ROOM, key).subarray(0, 24)),
      new TextDecoder().decode(signedCloseBytes(ROOM).subarray(0, 23)),
    ]).toEqual([false, false, 'Tasklace relay create v1', 'Tasklace relay close v1']);
  });
});

describe('what a member sends the relay', () => {
  it('reads back every frame as it was written', () => {
    const frames: ClientFrame[] = [
      {
        type: 'create',
        roomId: ROOM,
        verifyKey: new Uint8Array(32).fill(5),
        signature: new Uint8Array(64).fill(6),
      },
      { type: 'hello', roomId: ROOM, since: MAX_RELAY_SEQUENCE },
      { type: 'hello', roomId: ROOM, since: 0 },
      { type: 'append', record: encodeRelayRecord(RECORD) },
      { type: 'presence', bytes: new Uint8Array(MAX_RELAY_PRESENCE_BYTES) },
      { type: 'presence', bytes: new Uint8Array() },
      { type: 'close', signature: new Uint8Array(64).fill(7) },
    ];
    expect(frames.map((frame) => readClientFrame(encodeClientFrame(frame)))).toEqual(frames);
  });

  it('tells a frame of another version apart from one it cannot read', () => {
    expect([
      readClientFrame(rawFrame(2, [], 3)),
      readClientFrame(rawFrame(2, [], 0)),
      readClientFrame(Uint8Array.of(RELAY_WIRE_VERSION)),
      readClientFrame(new Uint8Array(MAX_RELAY_FRAME_BYTES + 1)),
      readClientFrame(rawFrame(9, [])),
      readClientFrame(rawFrame(0, [])),
    ]).toEqual(['UNSUPPORTED_VERSION', 'UNSUPPORTED_VERSION', null, null, null, null]);
  });

  it('refuses each frame whose content does not have the length or shape of its type', () => {
    const hello = encodeClientFrame({ type: 'hello', roomId: ROOM, since: 1 });
    expect(
      [
        rawFrame(
          1,
          Array.from({ length: 127 }, () => 0),
        ),
        hello.subarray(0, hello.length - 1),
        withHugeNumber(hello, HEADER_BYTES + 32),
        encodeClientFrame({ type: 'append', record: new Uint8Array(10) }),
        encodeClientFrame({
          type: 'presence',
          bytes: new Uint8Array(MAX_RELAY_PRESENCE_BYTES + 1),
        }),
        encodeClientFrame({ type: 'close', signature: new Uint8Array(63) }),
      ].map(readClientFrame),
    ).toEqual([null, null, null, null, null, null]);
  });

  it('never throws on any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        readClientFrame(bytes);
        readRelayFrame(bytes);
        readRelayRecord(bytes);
      }),
    );
  });
});

describe('what the relay sends a member', () => {
  it('reads back every frame as it was written', () => {
    const frames: RelayFrame[] = [
      {
        type: 'welcome',
        member: 7,
        verifyKey: new Uint8Array(32).fill(5),
        members: [1, 4_294_967_295],
      },
      { type: 'welcome', member: 1, verifyKey: new Uint8Array(32).fill(5), members: [] },
      { type: 'record', seq: 12, record: encodeRelayRecord(RECORD) },
      { type: 'caughtUp' },
      { type: 'presence', member: 3, bytes: Uint8Array.of(1, 2) },
      { type: 'joined', member: 4 },
      { type: 'left', member: 4 },
      { type: 'closed' },
      ...(
        [
          'UNSUPPORTED_VERSION',
          'MALFORMED',
          'NO_ROOM',
          'ROOM_EXISTS',
          'BAD_SIGNATURE',
          'TOO_LARGE',
          'ROOM_FULL',
          'RELAY_FULL',
          'TOO_MANY',
          'TOO_FAST',
          'STALE',
          'RELAY_FAILED',
        ] as const
      ).map((reason): RelayFrame => ({ type: 'refused', reason })),
    ];
    expect(frames.map((frame) => readRelayFrame(encodeRelayFrame(frame)))).toEqual(frames);
  });

  it('writes each refusal with its own code', () => {
    expect(encodeRelayFrame({ type: 'refused', reason: 'TOO_FAST' })).toEqual(
      Uint8Array.of(2, 7, 9),
    );
  });

  it('refuses a welcome with too many members, a member twice or a broken length', () => {
    /** Writes a welcome naming the members already in. */
    const welcome = (members: readonly number[]) =>
      encodeRelayFrame({ type: 'welcome', member: 0, verifyKey: new Uint8Array(32), members });
    const full = Array.from({ length: MAX_RELAY_MEMBERS }, (_unused, index) => index + 1);
    expect([
      typeOf(readRelayFrame(welcome(full))),
      readRelayFrame(welcome([...full, MAX_RELAY_MEMBERS + 1])),
      readRelayFrame(welcome([2, 2])),
      readRelayFrame(welcome([2]).subarray(0, 41)),
      readRelayFrame(welcome([]).subarray(0, 37)),
    ]).toEqual(['welcome', null, null, null, null]);
  });

  it('refuses a record without a sequence, at sequence zero or beyond the safe integers, or not a record', () => {
    const record = encodeRelayFrame({ type: 'record', seq: 1, record: encodeRelayRecord(RECORD) });
    expect(
      [
        rawFrame(2, [0, 0, 0]),
        encodeRelayFrame({ type: 'record', seq: 0, record: encodeRelayRecord(RECORD) }),
        withHugeNumber(record, HEADER_BYTES),
        encodeRelayFrame({ type: 'record', seq: 1, record: new Uint8Array(3) }),
      ].map(readRelayFrame),
    ).toEqual([null, null, null, null]);
  });

  it('refuses the other frames with content they do not hold', () => {
    expect(
      [
        rawFrame(3, [0]),
        rawFrame(8, [0]),
        rawFrame(4, [0, 0, 0]),
        encodeRelayFrame({
          type: 'presence',
          member: 1,
          bytes: new Uint8Array(MAX_RELAY_PRESENCE_BYTES + 1),
        }),
        rawFrame(5, [0, 0, 0]),
        rawFrame(6, [0, 0, 0, 0, 0]),
        rawFrame(7, []),
        rawFrame(7, [12]),
        rawFrame(7, [0, 0]),
        rawFrame(9, []),
      ].map(readRelayFrame),
    ).toEqual([null, null, null, null, null, null, null, null, null, null]);
  });

  it('reads a presence of the largest size', () => {
    const largest = encodeRelayFrame({
      type: 'presence',
      member: 2,
      bytes: new Uint8Array(MAX_RELAY_PRESENCE_BYTES),
    });
    expect(typeOf(readRelayFrame(largest))).toBe('presence');
  });

  it('tells a frame of another version apart from one it cannot read', () => {
    expect([readRelayFrame(rawFrame(3, [], 3)), readRelayFrame(Uint8Array.of(1))]).toEqual([
      'UNSUPPORTED_VERSION',
      null,
    ]);
  });
});

/** Tells whether two byte strings hold the same bytes. */
function bytesEqual(first: Uint8Array, second: Uint8Array): boolean {
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

/** Gives the type of a frame read, or what was read when it is not a frame. */
function typeOf(frame: ReturnType<typeof readRelayFrame>): string | null {
  return frame === null || typeof frame === 'string' ? frame : frame.type;
}
