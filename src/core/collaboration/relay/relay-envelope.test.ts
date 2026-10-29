import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { failure, success } from '../../result';
import { plainCompression, seededRandom, testAead } from '../../testing/test-crypto';
import { AEAD_TAG_BYTES, NONCE_BYTES } from '../secure/channel';
import {
  MAX_PRESENCE_MESSAGE_BYTES,
  createRelayAssembler,
  openRelayPresence,
  sealRelayMessage,
  sealRelayPresence,
  type MessageToSeal,
  type RelayCrypto,
} from './relay-envelope';
import {
  drawRelayAccess,
  messageKeyOf,
  relayKeysOf,
  viewAccessOf,
  type RelayKeys,
} from './relay-keys';
import {
  MAX_RELAY_PRESENCE_BYTES,
  RECORD_SIGNATURE_OFFSET,
  SALT_BYTES,
  coveredSequence,
  encodeRelayRecord,
  readRelayRecord,
  signedRecordBytes,
  type RelayRecord,
} from './relay-wire';

const ACCESS = drawRelayAccess(seededRandom(11));
const EDIT = relayKeysOf(ACCESS);
const VIEW = relayKeysOf(viewAccessOf(ACCESS));
const OTHER = relayKeysOf(drawRelayAccess(seededRandom(12)));
const ZERO_NONCE = new Uint8Array(NONCE_BYTES);
const MEMBER = 3;

/** Gives the test cipher and compression with a random source of a seed. */
function cryptoOf(seed = 1): RelayCrypto {
  return { aead: testAead, compression: plainCompression, randomBytes: seededRandom(seed) };
}

/** Builds a message of a kind with an identifier made of one byte, its author having seen what it covers. */
function message(
  bytes: Uint8Array,
  id = 1,
  kind: MessageToSeal['kind'] = 'update',
  covers = 0,
): MessageToSeal {
  return {
    ...coveredSequence(kind, covers),
    messageId: new Uint8Array(16).fill(id),
    seen: covers,
    bytes,
  };
}

/** Seals a message with the keys to edit, failing the test when it is refused. */
function sealed(
  content: MessageToSeal,
  keys: RelayKeys = EDIT,
  crypto = cryptoOf(),
): readonly Uint8Array[] {
  const records = sealRelayMessage(keys, content, crypto);
  if (!records.ok) {
    throw new Error(`Refused: ${records.error}`);
  }
  return records.value;
}

/** Writes and signs a record with the keys to edit, to forge what the sealing never writes. */
function signedRecord(record: RelayRecord, keys: RelayKeys = EDIT): Uint8Array {
  const bytes = encodeRelayRecord(record);
  bytes.set(
    keys.sign?.(signedRecordBytes(keys.roomId, bytes)) ?? new Uint8Array(64),
    RECORD_SIGNATURE_OFFSET,
  );
  return bytes;
}

/** Gives the first record of a message, failing the test when there is none. */
function first(records: readonly Uint8Array[]): Uint8Array {
  const [record] = records;
  if (record === undefined) {
    throw new Error('No record');
  }
  return record;
}

describe('sealing a message for the relay', () => {
  it('opens a sealed message as it was, telling its size on the relay', () => {
    const assembler = createRelayAssembler(VIEW, cryptoOf());
    const records = sealed(message(Uint8Array.of(1, 2, 3), 4, 'snapshot', 9));
    expect([records.length, assembler.take(1, first(records))]).toEqual([
      1,
      success({
        kind: 'snapshot',
        messageId: new Uint8Array(16).fill(4),
        covers: 9,
        bytes: Uint8Array.of(1, 2, 3),
        compressedBytes: 3 + AEAD_TAG_BYTES,
      }),
    ]);
  });

  it('encrypts each message under a key of its own drawn from a random salt, so that the same message is sealed differently twice', () => {
    const crypto = cryptoOf(3);
    const once = readRelayRecord(first(sealed(message(Uint8Array.of(7)), EDIT, crypto)));
    const twice = readRelayRecord(first(sealed(message(Uint8Array.of(7)), EDIT, crypto)));
    const salt = once?.salt ?? new Uint8Array();
    expect([
      salt.length,
      bytesToHex(salt) === bytesToHex(twice?.salt ?? new Uint8Array()),
      once?.chunk,
    ]).toEqual([
      SALT_BYTES,
      false,
      testAead.seal(messageKeyOf(EDIT.encryptionKey, salt), ZERO_NONCE, Uint8Array.of(7)),
    ]);
  });

  it('refuses a member who may only view', () => {
    expect(sealRelayMessage(VIEW, message(Uint8Array.of(1)), cryptoOf())).toEqual(
      failure('READ_ONLY'),
    );
  });

  it('seals an empty message in one empty chunk of its tag only', () => {
    const records = sealed(message(new Uint8Array()));
    expect([records.length, readRelayRecord(first(records))?.chunk.length]).toEqual([
      1,
      AEAD_TAG_BYTES,
    ]);
  });
});

describe('rebuilding messages from what the relay passes on', () => {
  it('refuses bytes that are not a record, a record not signed with the key of the plan, signed for another room, or changed after signing', () => {
    const record = first(sealed(message(Uint8Array.of(1, 2))));
    const changedChunk = Uint8Array.from(record);
    changedChunk[changedChunk.length - 1] = (changedChunk[changedChunk.length - 1] ?? 0) ^ 1;
    const changedId = Uint8Array.from(record);
    changedId[1] = (changedId[1] ?? 0) ^ 1;
    const assembler = createRelayAssembler(VIEW, cryptoOf());
    const otherAssembler = createRelayAssembler(OTHER, cryptoOf());
    expect([
      assembler.take(1, Uint8Array.of(1, 2, 3)),
      assembler.take(2, first(sealed(message(Uint8Array.of(1)), OTHER))),
      otherAssembler.take(3, record),
      assembler.take(4, changedChunk),
      assembler.take(5, changedId),
      assembler.take(
        6,
        signedRecord(readRelayRecord(record) ?? fail(), { ...EDIT, roomId: OTHER.roomId }),
      ),
    ]).toEqual([
      failure('MALFORMED'),
      failure('BAD_SIGNATURE'),
      failure('BAD_SIGNATURE'),
      failure('BAD_SIGNATURE'),
      failure('BAD_SIGNATURE'),
      failure('BAD_SIGNATURE'),
    ]);
  });

  it('refuses a chunk of the same message and salt that tells another kind, count or covered sequence', () => {
    const base: RelayRecord = {
      kind: 'update',
      messageId: new Uint8Array(16).fill(3),
      salt: new Uint8Array(16).fill(3),
      index: 0,
      count: 2,
      covers: 0,
      seen: 2,
      signature: new Uint8Array(64),
      chunk: Uint8Array.of(1),
    };
    const assembler = createRelayAssembler(VIEW, cryptoOf());
    expect([
      assembler.take(1, signedRecord(base)),
      assembler.take(2, signedRecord({ ...base, index: 1, count: 3 })),
      assembler.take(3, signedRecord({ ...base, index: 1, kind: 'snapshot', covers: 0 })),
      assembler.take(4, signedRecord({ ...base, index: 1, kind: 'snapshot', covers: 2 })),
    ]).toEqual([success(null), failure('MALFORMED'), failure('MALFORMED'), failure('MALFORMED')]);
  });

  it('refuses a signed message that does not decrypt, does not decompress, or decompresses beyond the limit', () => {
    const record = first(sealed(message(Uint8Array.of(1, 2, 3, 4))));
    const noDecryption: RelayCrypto = { ...cryptoOf(), aead: { ...testAead, open: () => null } };
    const noDecompression: RelayCrypto = {
      ...cryptoOf(),
      compression: { ...plainCompression, decompress: () => failure('INVALID_DATA') },
    };
    expect([
      createRelayAssembler(VIEW, noDecryption).take(1, record),
      createRelayAssembler(VIEW, noDecompression).take(1, record),
      createRelayAssembler(VIEW, cryptoOf(), 3).take(1, record),
      createRelayAssembler(VIEW, cryptoOf(), 4).take(1, record).ok,
    ]).toEqual([failure('UNREADABLE'), failure('UNREADABLE'), failure('TOO_LARGE'), true]);
  });

  it('tells no sequence as settled before any record', () => {
    expect(createRelayAssembler(VIEW, cryptoOf()).settled()).toBe(0);
  });

  it('never counts the sequence of a record that is not signed for the room as settled', () => {
    const assembler = createRelayAssembler(VIEW, cryptoOf());
    const taken = assembler.take(2, first(sealed(message(Uint8Array.of(1)))));
    const forged = assembler.take(1_000, first(sealed(message(Uint8Array.of(2), 2), OTHER)));
    expect([taken.ok, forged, assembler.settled()]).toEqual([true, failure('BAD_SIGNATURE'), 2]);
  });

  it('gives up a message still waiting for its chunks once a snapshot covers its first one, its author having had it whole', () => {
    const base: RelayRecord = {
      kind: 'update',
      messageId: new Uint8Array(16).fill(5),
      salt: new Uint8Array(16).fill(5),
      index: 0,
      count: 2,
      covers: 0,
      seen: 0,
      signature: new Uint8Array(64),
      chunk: Uint8Array.of(1),
    };
    const assembler = createRelayAssembler(VIEW, cryptoOf());
    const started = assembler.take(1, signedRecord(base));
    const before = assembler.settled();
    const snapshot = assembler.take(2, first(sealed(message(Uint8Array.of(9), 6, 'snapshot', 1))));
    expect([started, before, snapshot.ok, assembler.settled()]).toEqual([
      success(null),
      0,
      true,
      2,
    ]);
  });
});

describe('the presence of a member on the relay', () => {
  it('tells a member who may edit from its signature, and one who may only view without it', () => {
    const bytes = Uint8Array.of(4, 5);
    const fromEditor = sealRelayPresence(EDIT, MEMBER, bytes, cryptoOf());
    const fromViewer = sealRelayPresence(VIEW, MEMBER, bytes, cryptoOf());
    expect([
      fromEditor.ok ? openRelayPresence(VIEW, MEMBER, fromEditor.value, cryptoOf()) : fromEditor,
      fromViewer.ok ? openRelayPresence(EDIT, MEMBER, fromViewer.value, cryptoOf()) : fromViewer,
    ]).toEqual([
      { bytes, canEdit: true },
      { bytes, canEdit: false },
    ]);
  });

  it('refuses the signed presence of a member passed on under the number of another, as a member in read only who replays it', () => {
    const fromEditor = sealRelayPresence(EDIT, MEMBER, Uint8Array.of(4), cryptoOf());
    expect(
      fromEditor.ok
        ? openRelayPresence(VIEW, MEMBER + 1, fromEditor.value, cryptoOf())
        : fromEditor,
    ).toBeNull();
  });

  it('refuses a presence that claims a signature it does not have, an unknown mark, bytes that do not decrypt and sizes out of bounds', () => {
    const bytes = Uint8Array.of(4);
    const forged = sealRelayPresence({ ...EDIT, sign: OTHER.sign }, MEMBER, bytes, cryptoOf());
    const salt = new Uint8Array(SALT_BYTES).fill(2);
    const unknownMark = Uint8Array.from([
      ...salt,
      ...testAead.seal(messageKeyOf(EDIT.encryptionKey, salt), ZERO_NONCE, Uint8Array.of(2, 4)),
    ]);
    const empty = Uint8Array.from([
      ...salt,
      ...testAead.seal(messageKeyOf(EDIT.encryptionKey, salt), ZERO_NONCE, new Uint8Array()),
    ]);
    const sealedOk = sealRelayPresence(EDIT, MEMBER, bytes, cryptoOf());
    expect([
      forged.ok ? openRelayPresence(VIEW, MEMBER, forged.value, cryptoOf()) : forged,
      openRelayPresence(VIEW, MEMBER, unknownMark, cryptoOf()),
      openRelayPresence(VIEW, MEMBER, empty, cryptoOf()),
      sealedOk.ok ? openRelayPresence(OTHER, MEMBER, sealedOk.value, cryptoOf()) : sealedOk,
      openRelayPresence(VIEW, MEMBER, new Uint8Array(SALT_BYTES - 1), cryptoOf()),
      openRelayPresence(VIEW, MEMBER, new Uint8Array(MAX_RELAY_PRESENCE_BYTES + 1), cryptoOf()),
    ]).toEqual([null, null, null, null, null, null]);
  });

  it('seals a presence up to the size the relay passes on, and refuses a larger one', () => {
    const largest = sealRelayPresence(
      EDIT,
      MEMBER,
      new Uint8Array(MAX_PRESENCE_MESSAGE_BYTES),
      cryptoOf(),
    );
    expect([
      largest.ok ? largest.value.length : largest,
      sealRelayPresence(EDIT, MEMBER, new Uint8Array(MAX_PRESENCE_MESSAGE_BYTES + 1), cryptoOf()),
    ]).toEqual([MAX_RELAY_PRESENCE_BYTES, failure('TOO_LARGE')]);
  });
});

/** Fails the test where a value had to be there. */
function fail(): never {
  throw new Error('A value was missing.');
}
