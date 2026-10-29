import { bytesToHex } from '@noble/hashes/utils.js';
import {
  MAX_COLLABORATION_MESSAGE_BYTES,
  MAX_OPEN_RELAY_MESSAGES,
  MAX_RELAY_BUFFERED_BYTES,
  RELAY_ABANDON_AFTER_RECORDS,
} from '../../limits';
import { failure, success, type Result } from '../../result';
import type { Compressor } from '../../file/tasklace-file';
import { AEAD_TAG_BYTES, NONCE_BYTES, type Aead } from '../secure/channel';
import { isSignedBy, messageKeyOf, type RelayKeys } from './relay-keys';
import {
  MAX_RELAY_CHUNKS,
  MAX_RELAY_PRESENCE_BYTES,
  RECORD_SIGNATURE_OFFSET,
  RELAY_CHUNK_BYTES,
  SALT_BYTES,
  SIGNATURE_BYTES,
  encodeRelayRecord,
  readRelayRecord,
  signedRecordBytes,
  coveredSequence,
  type CoveredSequence,
  type RelayRecord,
} from './relay-wire';

export interface RelayCrypto {
  readonly aead: Aead;
  readonly compression: Compressor;
  readonly randomBytes: (count: number) => Uint8Array;
}

export type RelayMessage = CoveredSequence & {
  readonly messageId: Uint8Array;
  readonly bytes: Uint8Array;
};

export type MessageToSeal = RelayMessage & {
  readonly seen: number;
};

export type OpenedRelayMessage = RelayMessage & {
  readonly compressedBytes: number;
};

export interface OpenedPresence {
  readonly bytes: Uint8Array;
  readonly canEdit: boolean;
}

export type SealRefusal = 'READ_ONLY' | 'TOO_LARGE';
export type RecordRefusal = 'MALFORMED' | 'BAD_SIGNATURE' | 'TOO_MANY' | 'UNREADABLE' | 'TOO_LARGE';

export interface RelayAssembler {
  readonly take: (
    seq: number,
    record: Uint8Array,
  ) => Result<OpenedRelayMessage | null, RecordRefusal>;
  readonly settled: () => number;
}

interface Assembly {
  readonly first: RelayRecord;
  readonly firstSeq: number;
  readonly chunks: (Uint8Array | undefined)[];
  bytes: number;
  received: number;
}

const ZERO_NONCE = new Uint8Array(NONCE_BYTES);
const PRESENCE_DOMAIN = new TextEncoder().encode('Tasklace relay presence v2');
const MEMBER_BYTES = 4;
const SIGNED_PRESENCE = 1;
const UNSIGNED_PRESENCE = 0;
const PRESENCE_FLAG_BYTES = 1;
const PRESENCE_OVERHEAD = SALT_BYTES + PRESENCE_FLAG_BYTES + SIGNATURE_BYTES + AEAD_TAG_BYTES;
export const MAX_PRESENCE_MESSAGE_BYTES = MAX_RELAY_PRESENCE_BYTES - PRESENCE_OVERHEAD;

/** Seals a message of the plan for the relay: compressed, encrypted under a key drawn from a random salt, cut into chunks each signed with the last sequence its author had seen, refusing a member who may not edit and a message too large. */
export function sealRelayMessage(
  keys: RelayKeys,
  message: MessageToSeal,
  crypto: RelayCrypto,
): Result<readonly Uint8Array[], SealRefusal> {
  if (keys.kind === 'view') {
    return failure('READ_ONLY');
  }
  const { sign } = keys;
  if (message.bytes.length > MAX_COLLABORATION_MESSAGE_BYTES) {
    return failure('TOO_LARGE');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const sealed = crypto.aead.seal(
    messageKeyOf(keys.encryptionKey, salt),
    ZERO_NONCE,
    crypto.compression.compress(message.bytes),
  );
  const count = Math.max(1, Math.ceil(sealed.length / RELAY_CHUNK_BYTES));
  if (count > MAX_RELAY_CHUNKS) {
    return failure('TOO_LARGE');
  }
  return success(
    Array.from({ length: count }, (_unused, index) => {
      const record = encodeRelayRecord({
        ...coveredSequence(message.kind, message.covers),
        messageId: message.messageId,
        salt,
        index,
        count,
        seen: message.seen,
        signature: new Uint8Array(SIGNATURE_BYTES),
        chunk: sealed.subarray(index * RELAY_CHUNK_BYTES, (index + 1) * RELAY_CHUNK_BYTES),
      });
      record.set(sign(signedRecordBytes(keys.roomId, record)), RECORD_SIGNATURE_OFFSET);
      return record;
    }),
  );
}

/** Rebuilds messages from the records the relay passes on, in any order and from several authors, refusing a record not signed for this room, waiting within bounds and giving up a message whose chunks stop coming or that a snapshot already holds. */
export function createRelayAssembler(
  keys: RelayKeys,
  crypto: RelayCrypto,
  limit = MAX_COLLABORATION_MESSAGE_BYTES,
): RelayAssembler {
  const open = new Map<string, Assembly>();
  let buffered = 0;
  let lastSeq = 0;
  /** Forgets a message whose chunks are all in or will never come. */
  const drop = (key: string, assembly: Assembly): void => {
    open.delete(key);
    buffered -= assembly.bytes;
  };
  /** Gives up the messages that waited too long for their next chunk, and those a snapshot covers, whose author had them whole since a snapshot covers only what its author settled. */
  const abandonStale = (covered: number): void => {
    for (const [key, assembly] of open) {
      if (
        lastSeq - assembly.firstSeq > RELAY_ABANDON_AFTER_RECORDS ||
        assembly.firstSeq <= covered
      ) {
        drop(key, assembly);
      }
    }
  };
  /** Decrypts and decompresses a message once all its chunks are in. */
  const finish = (assembly: Assembly): Result<OpenedRelayMessage, RecordRefusal> => {
    const sealed = joined(assembly.chunks.filter((chunk) => chunk !== undefined));
    const { first } = assembly;
    const compressed = crypto.aead.open(
      messageKeyOf(keys.encryptionKey, first.salt),
      ZERO_NONCE,
      sealed,
    );
    if (compressed === null) {
      return failure('UNREADABLE');
    }
    const bytes = crypto.compression.decompress(compressed, limit);
    if (!bytes.ok) {
      return failure(bytes.error === 'OUTPUT_TOO_LARGE' ? 'TOO_LARGE' : 'UNREADABLE');
    }
    return success({
      ...coveredSequence(first.kind, first.covers),
      messageId: first.messageId,
      bytes: bytes.value,
      compressedBytes: sealed.length,
    });
  };
  /** Starts the assembly of a message from its first chunk to arrive, within the number of messages and bytes waiting. */
  const start = (
    key: string,
    seq: number,
    record: RelayRecord,
  ): Result<Assembly, RecordRefusal> => {
    if (open.size >= MAX_OPEN_RELAY_MESSAGES) {
      return failure('TOO_MANY');
    }
    const assembly: Assembly = {
      first: record,
      firstSeq: seq,
      chunks: Array.from({ length: record.count }),
      bytes: 0,
      received: 0,
    };
    open.set(key, assembly);
    return success(assembly);
  };
  return {
    take: (seq, bytes) => {
      const record = readRelayRecord(bytes);
      if (record === null) {
        return failure('MALFORMED');
      }
      if (!isSignedBy(keys.verifyKey, signedRecordBytes(keys.roomId, bytes), record.signature)) {
        return failure('BAD_SIGNATURE');
      }
      lastSeq = Math.max(lastSeq, seq);
      abandonStale(0);
      const key = `${bytesToHex(record.messageId)}.${bytesToHex(record.salt)}`;
      const known = open.get(key);
      const assembly = known === undefined ? start(key, seq, record) : success(known);
      if (!assembly.ok) {
        return assembly;
      }
      const { value } = assembly;
      if (!isSameMessage(value.first, record)) {
        return failure('MALFORMED');
      }
      if (value.chunks[record.index] !== undefined) {
        return success(null);
      }
      if (buffered + record.chunk.length > MAX_RELAY_BUFFERED_BYTES) {
        drop(key, value);
        return failure('TOO_LARGE');
      }
      value.chunks[record.index] = record.chunk;
      value.bytes += record.chunk.length;
      value.received += 1;
      buffered += record.chunk.length;
      if (value.received < record.count) {
        return success(null);
      }
      drop(key, value);
      const finished = finish(value);
      if (finished.ok && finished.value.kind === 'snapshot') {
        abandonStale(finished.value.covers);
      }
      return finished;
    },
    settled: () =>
      [...open.values()].reduce(
        (lowest, assembly) => Math.min(lowest, assembly.firstSeq - 1),
        lastSeq,
      ),
  };
}

/** Seals the presence of a member under the number the relay gave it: encrypted under a key of its own and, for a member who may edit, signed, so that a member in read only cannot pass for one who edits. */
export function sealRelayPresence(
  keys: RelayKeys,
  member: number,
  bytes: Uint8Array,
  crypto: RelayCrypto,
): Result<Uint8Array, 'TOO_LARGE'> {
  if (bytes.length > MAX_PRESENCE_MESSAGE_BYTES) {
    return failure('TOO_LARGE');
  }
  const signature =
    keys.sign === null ? new Uint8Array() : keys.sign(signedPresenceBytes(keys, member, bytes));
  const inner = joined([
    Uint8Array.of(keys.sign === null ? UNSIGNED_PRESENCE : SIGNED_PRESENCE),
    signature,
    bytes,
  ]);
  const salt = crypto.randomBytes(SALT_BYTES);
  return success(
    joined([salt, crypto.aead.seal(messageKeyOf(keys.encryptionKey, salt), ZERO_NONCE, inner)]),
  );
}

/** Opens the presence the relay passed on under the number of a member, telling whether it may edit from its signature, or returns null for bytes that do not decrypt, are not a presence or carry a signature that does not hold for that member. */
export function openRelayPresence(
  keys: RelayKeys,
  member: number,
  sealed: Uint8Array,
  crypto: RelayCrypto,
): OpenedPresence | null {
  if (sealed.length < SALT_BYTES || sealed.length > MAX_RELAY_PRESENCE_BYTES) {
    return null;
  }
  const salt = sealed.subarray(0, SALT_BYTES);
  const inner = crypto.aead.open(
    messageKeyOf(keys.encryptionKey, salt),
    ZERO_NONCE,
    sealed.subarray(SALT_BYTES),
  );
  if (inner === null || inner.length < PRESENCE_FLAG_BYTES) {
    return null;
  }
  if (inner[0] === UNSIGNED_PRESENCE) {
    return { bytes: inner.slice(PRESENCE_FLAG_BYTES), canEdit: false };
  }
  const signature = inner.subarray(PRESENCE_FLAG_BYTES, PRESENCE_FLAG_BYTES + SIGNATURE_BYTES);
  const bytes = inner.slice(PRESENCE_FLAG_BYTES + SIGNATURE_BYTES);
  if (
    inner[0] !== SIGNED_PRESENCE ||
    !isSignedBy(keys.verifyKey, signedPresenceBytes(keys, member, bytes), signature)
  ) {
    return null;
  }
  return { bytes, canEdit: true };
}

/** Gives the bytes the signature of a presence covers: a domain, the room, the number the relay gave its member and the presence, so that a member who replays the presence of another under its own number does not pass for one who edits. */
function signedPresenceBytes(keys: RelayKeys, member: number, bytes: Uint8Array): Uint8Array {
  const number = new Uint8Array(MEMBER_BYTES);
  new DataView(number.buffer).setUint32(0, member);
  return joined([PRESENCE_DOMAIN, keys.roomId, number, bytes]);
}

/** Tells whether a chunk belongs to the same message as the first one received, its kind, count and covered sequence matching. */
function isSameMessage(first: RelayRecord, record: RelayRecord): boolean {
  return (
    first.kind === record.kind && first.count === record.count && first.covers === record.covers
  );
}

/** Joins byte strings into one. */
function joined(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
