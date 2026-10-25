export const RELAY_WIRE_VERSION = 1;
export const ROOM_ID_BYTES = 32;
export const VERIFY_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;
export const MESSAGE_ID_BYTES = 16;
export const SALT_BYTES = 16;
export const RELAY_CHUNK_BYTES = 1_048_576;
export const MAX_RELAY_CHUNKS = 256;
export const MAX_RELAY_PRESENCE_BYTES = 4_096;
export const MAX_RELAY_MEMBERS = 64;
export const MAX_RELAY_SEQUENCE = Number.MAX_SAFE_INTEGER;

export type RelayRecordKind = 'update' | 'snapshot';

export interface RelayRecord {
  readonly kind: RelayRecordKind;
  readonly messageId: Uint8Array;
  readonly salt: Uint8Array;
  readonly index: number;
  readonly count: number;
  readonly covers: number;
  readonly signature: Uint8Array;
  readonly chunk: Uint8Array;
}

export type RelayRefusal =
  | 'UNSUPPORTED_VERSION'
  | 'MALFORMED'
  | 'NO_ROOM'
  | 'ROOM_EXISTS'
  | 'BAD_SIGNATURE'
  | 'TOO_LARGE'
  | 'ROOM_FULL'
  | 'RELAY_FULL'
  | 'TOO_MANY'
  | 'TOO_FAST';

export type ClientFrame =
  | {
      readonly type: 'create';
      readonly roomId: Uint8Array;
      readonly verifyKey: Uint8Array;
      readonly signature: Uint8Array;
    }
  | { readonly type: 'hello'; readonly roomId: Uint8Array; readonly since: number }
  | { readonly type: 'append'; readonly record: Uint8Array }
  | { readonly type: 'presence'; readonly bytes: Uint8Array }
  | { readonly type: 'close'; readonly signature: Uint8Array };

export type RelayFrame =
  | {
      readonly type: 'welcome';
      readonly member: number;
      readonly verifyKey: Uint8Array;
      readonly members: readonly number[];
    }
  | { readonly type: 'record'; readonly seq: number; readonly record: Uint8Array }
  | { readonly type: 'caughtUp' }
  | { readonly type: 'presence'; readonly member: number; readonly bytes: Uint8Array }
  | { readonly type: 'joined' | 'left'; readonly member: number }
  | { readonly type: 'refused'; readonly reason: RelayRefusal }
  | { readonly type: 'closed' };

const FRAME_HEADER_BYTES = 2;
const SEQUENCE_BYTES = 8;
const MEMBER_BYTES = 4;
const COUNT_BYTES = 2;
const RECORD_DOMAIN = new TextEncoder().encode('Tasklace relay record v1');
const CREATE_DOMAIN = new TextEncoder().encode('Tasklace relay create v1');
const CLOSE_DOMAIN = new TextEncoder().encode('Tasklace relay close v1');
const RECORD_KINDS: readonly RelayRecordKind[] = ['update', 'snapshot'];
const FIRST_CODE = 1;
const CLIENT_CODES: Readonly<Record<ClientFrame['type'], number>> = {
  create: 1,
  hello: 2,
  append: 3,
  presence: 4,
  close: 5,
};
const RELAY_CODES: Readonly<Record<RelayFrame['type'], number>> = {
  welcome: 1,
  record: 2,
  caughtUp: 3,
  presence: 4,
  joined: 5,
  left: 6,
  refused: 7,
  closed: 8,
};
const REFUSALS: readonly RelayRefusal[] = [
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
];
const KIND_OFFSET = 0;
const MESSAGE_ID_OFFSET = 1;
const SALT_OFFSET = MESSAGE_ID_OFFSET + MESSAGE_ID_BYTES;
const INDEX_OFFSET = SALT_OFFSET + SALT_BYTES;
const COUNT_OFFSET = INDEX_OFFSET + COUNT_BYTES;
const COVERS_OFFSET = COUNT_OFFSET + COUNT_BYTES;
export const RECORD_SIGNATURE_OFFSET = COVERS_OFFSET + SEQUENCE_BYTES;
const SIGNATURE_OFFSET = RECORD_SIGNATURE_OFFSET;
const CHUNK_OFFSET = SIGNATURE_OFFSET + SIGNATURE_BYTES;

export const MAX_RELAY_RECORD_BYTES = CHUNK_OFFSET + RELAY_CHUNK_BYTES;
export const MAX_RELAY_FRAME_BYTES = FRAME_HEADER_BYTES + SEQUENCE_BYTES + MAX_RELAY_RECORD_BYTES;

/** Writes one chunk of a message as the record the relay keeps and passes on: its kind, the message it belongs to, the salt of its key, its place among the chunks, the sequence a snapshot covers, the signature and the chunk. */
export function encodeRelayRecord(record: RelayRecord): Uint8Array {
  const bytes = new Uint8Array(CHUNK_OFFSET + record.chunk.length);
  const view = new DataView(bytes.buffer);
  bytes[KIND_OFFSET] = RECORD_KINDS.indexOf(record.kind) + FIRST_CODE;
  bytes.set(record.messageId, MESSAGE_ID_OFFSET);
  bytes.set(record.salt, SALT_OFFSET);
  view.setUint16(INDEX_OFFSET, record.index);
  view.setUint16(COUNT_OFFSET, record.count);
  view.setBigUint64(COVERS_OFFSET, BigInt(record.covers));
  bytes.set(record.signature, SIGNATURE_OFFSET);
  bytes.set(record.chunk, CHUNK_OFFSET);
  return bytes;
}

/** Reads a record from untrusted bytes, returning null for an unknown kind, a chunk out of place, too many chunks, a sequence beyond the safe integers or a chunk too large, without ever throwing. */
export function readRelayRecord(bytes: Uint8Array): RelayRecord | null {
  if (bytes.length < CHUNK_OFFSET || bytes.length > MAX_RELAY_RECORD_BYTES) {
    return null;
  }
  const view = viewOf(bytes);
  const kind = RECORD_KINDS[(bytes[KIND_OFFSET] ?? 0) - FIRST_CODE];
  const index = view.getUint16(INDEX_OFFSET);
  const count = view.getUint16(COUNT_OFFSET);
  const covers = safeInteger(view.getBigUint64(COVERS_OFFSET));
  if (kind === undefined || count === 0 || count > MAX_RELAY_CHUNKS || index >= count) {
    return null;
  }
  if (covers === null || (kind === 'update' && covers !== 0)) {
    return null;
  }
  return {
    kind,
    messageId: bytes.slice(MESSAGE_ID_OFFSET, SALT_OFFSET),
    salt: bytes.slice(SALT_OFFSET, INDEX_OFFSET),
    index,
    count,
    covers,
    signature: bytes.slice(SIGNATURE_OFFSET, CHUNK_OFFSET),
    chunk: bytes.subarray(CHUNK_OFFSET),
  };
}

/** Gives the bytes the signature of a record covers: a domain, the room, and every byte of the record but the signature, so that a record signed for one room or one place never passes for another. */
export function signedRecordBytes(roomId: Uint8Array, record: Uint8Array): Uint8Array {
  return joined([
    RECORD_DOMAIN,
    roomId,
    record.subarray(0, SIGNATURE_OFFSET),
    record.subarray(CHUNK_OFFSET),
  ]);
}

/** Gives the bytes signed to create a room: a domain, the room and the key that will check its records. */
export function signedCreateBytes(roomId: Uint8Array, verifyKey: Uint8Array): Uint8Array {
  return joined([CREATE_DOMAIN, roomId, verifyKey]);
}

/** Gives the bytes signed to close a room for good. */
export function signedCloseBytes(roomId: Uint8Array): Uint8Array {
  return joined([CLOSE_DOMAIN, roomId]);
}

/** Writes what a member sends the relay, after the version of the format and the type of the frame. */
export function encodeClientFrame(frame: ClientFrame): Uint8Array {
  switch (frame.type) {
    case 'create':
      return framed(CLIENT_CODES.create, [frame.roomId, frame.verifyKey, frame.signature]);
    case 'hello':
      return framed(CLIENT_CODES.hello, [frame.roomId, sequenceBytes(frame.since)]);
    case 'append':
      return framed(CLIENT_CODES.append, [frame.record]);
    case 'presence':
      return framed(CLIENT_CODES.presence, [frame.bytes]);
    case 'close':
      return framed(CLIENT_CODES.close, [frame.signature]);
  }
}

/** Reads what a member sent, as the relay does, returning null for another version, an unknown type or bytes that do not fit the type, without ever throwing. */
export function readClientFrame(bytes: Uint8Array): ClientFrame | 'UNSUPPORTED_VERSION' | null {
  const body = bodyOf(bytes);
  if (body === 'UNSUPPORTED_VERSION' || body === null) {
    return body;
  }
  const { code, content } = body;
  switch (code) {
    case CLIENT_CODES.create:
      return content.length === ROOM_ID_BYTES + VERIFY_KEY_BYTES + SIGNATURE_BYTES
        ? {
            type: 'create',
            roomId: content.slice(0, ROOM_ID_BYTES),
            verifyKey: content.slice(ROOM_ID_BYTES, ROOM_ID_BYTES + VERIFY_KEY_BYTES),
            signature: content.slice(ROOM_ID_BYTES + VERIFY_KEY_BYTES),
          }
        : null;
    case CLIENT_CODES.hello:
      return readHello(content);
    case CLIENT_CODES.append:
      return readRelayRecord(content) === null ? null : { type: 'append', record: content };
    case CLIENT_CODES.presence:
      return content.length > MAX_RELAY_PRESENCE_BYTES
        ? null
        : { type: 'presence', bytes: content };
    case CLIENT_CODES.close:
      return content.length === SIGNATURE_BYTES ? { type: 'close', signature: content } : null;
    default:
      return null;
  }
}

/** Reads the frame a member opens a room with: the room and the last sequence it already has. */
function readHello(content: Uint8Array): ClientFrame | null {
  if (content.length !== ROOM_ID_BYTES + SEQUENCE_BYTES) {
    return null;
  }
  const since = safeInteger(viewOf(content).getBigUint64(ROOM_ID_BYTES));
  return since === null ? null : { type: 'hello', roomId: content.slice(0, ROOM_ID_BYTES), since };
}

/** Writes what the relay sends a member, after the version of the format and the type of the frame. */
export function encodeRelayFrame(frame: RelayFrame): Uint8Array {
  switch (frame.type) {
    case 'welcome':
      return framed(RELAY_CODES.welcome, [
        memberBytes(frame.member),
        frame.verifyKey,
        ...frame.members.map(memberBytes),
      ]);
    case 'record':
      return framed(RELAY_CODES.record, [sequenceBytes(frame.seq), frame.record]);
    case 'caughtUp':
    case 'closed':
      return framed(RELAY_CODES[frame.type], []);
    case 'presence':
      return framed(RELAY_CODES.presence, [memberBytes(frame.member), frame.bytes]);
    case 'joined':
    case 'left':
      return framed(RELAY_CODES[frame.type], [memberBytes(frame.member)]);
    case 'refused':
      return framed(RELAY_CODES.refused, [Uint8Array.of(REFUSALS.indexOf(frame.reason))]);
  }
}

/** Reads what the relay sent, as a member does, returning null for another version, an unknown type or bytes that do not fit the type, without ever throwing. */
export function readRelayFrame(bytes: Uint8Array): RelayFrame | 'UNSUPPORTED_VERSION' | null {
  const body = bodyOf(bytes);
  if (body === 'UNSUPPORTED_VERSION' || body === null) {
    return body;
  }
  const { code, content } = body;
  switch (code) {
    case RELAY_CODES.welcome:
      return readWelcome(content);
    case RELAY_CODES.record:
      return readRecordFrame(content);
    case RELAY_CODES.caughtUp:
      return content.length === 0 ? { type: 'caughtUp' } : null;
    case RELAY_CODES.closed:
      return content.length === 0 ? { type: 'closed' } : null;
    case RELAY_CODES.presence:
      return content.length < MEMBER_BYTES ||
        content.length > MEMBER_BYTES + MAX_RELAY_PRESENCE_BYTES
        ? null
        : {
            type: 'presence',
            member: viewOf(content).getUint32(0),
            bytes: content.slice(MEMBER_BYTES),
          };
    case RELAY_CODES.joined:
    case RELAY_CODES.left:
      return content.length === MEMBER_BYTES
        ? {
            type: code === RELAY_CODES.joined ? 'joined' : 'left',
            member: viewOf(content).getUint32(0),
          }
        : null;
    case RELAY_CODES.refused:
      return readRefused(content);
    default:
      return null;
  }
}

/** Reads the welcome of the relay: the number of this member, the key the room checks records with, and the others already in, at most as many as a room holds and each once. */
function readWelcome(content: Uint8Array): RelayFrame | null {
  const othersBytes = content.length - MEMBER_BYTES - VERIFY_KEY_BYTES;
  if (
    othersBytes < 0 ||
    othersBytes % MEMBER_BYTES !== 0 ||
    othersBytes / MEMBER_BYTES > MAX_RELAY_MEMBERS
  ) {
    return null;
  }
  const view = viewOf(content);
  const members = Array.from({ length: othersBytes / MEMBER_BYTES }, (_unused, index) =>
    view.getUint32(MEMBER_BYTES + VERIFY_KEY_BYTES + index * MEMBER_BYTES),
  );
  if (new Set(members).size !== members.length) {
    return null;
  }
  return {
    type: 'welcome',
    member: view.getUint32(0),
    verifyKey: content.slice(MEMBER_BYTES, MEMBER_BYTES + VERIFY_KEY_BYTES),
    members,
  };
}

/** Reads a record the relay passes on, with the sequence it gave it. */
function readRecordFrame(content: Uint8Array): RelayFrame | null {
  if (content.length < SEQUENCE_BYTES) {
    return null;
  }
  const seq = safeInteger(viewOf(content).getBigUint64(0));
  const record = content.subarray(SEQUENCE_BYTES);
  return seq === null || seq === 0 || readRelayRecord(record) === null
    ? null
    : { type: 'record', seq, record };
}

/** Reads why the relay refused, from its code. */
function readRefused(content: Uint8Array): RelayFrame | null {
  const reason = content.length === 1 ? REFUSALS[content[0] ?? REFUSALS.length] : undefined;
  return reason === undefined ? null : { type: 'refused', reason };
}

/** Splits a frame into its type and content, telling a frame of another version apart from bytes too short or too long to be one. */
function bodyOf(
  bytes: Uint8Array,
): { readonly code: number; readonly content: Uint8Array } | 'UNSUPPORTED_VERSION' | null {
  if (bytes.length < FRAME_HEADER_BYTES || bytes.length > MAX_RELAY_FRAME_BYTES) {
    return null;
  }
  if (bytes[0] !== RELAY_WIRE_VERSION) {
    return 'UNSUPPORTED_VERSION';
  }
  return { code: bytes[1] ?? 0, content: bytes.subarray(FRAME_HEADER_BYTES) };
}

/** Writes a frame from its type code and its parts. */
function framed(code: number, parts: readonly Uint8Array[]): Uint8Array {
  return joined([Uint8Array.of(RELAY_WIRE_VERSION, code), ...parts]);
}

/** Writes a sequence on eight bytes. */
function sequenceBytes(seq: number): Uint8Array {
  const bytes = new Uint8Array(SEQUENCE_BYTES);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(seq));
  return bytes;
}

/** Writes the number of a member on four bytes. */
function memberBytes(member: number): Uint8Array {
  const bytes = new Uint8Array(MEMBER_BYTES);
  new DataView(bytes.buffer).setUint32(0, member);
  return bytes;
}

/** Turns a number read on eight bytes into a safe integer, or null beyond the largest one. */
function safeInteger(value: bigint): number | null {
  return value > BigInt(MAX_RELAY_SEQUENCE) ? null : Number(value);
}

/** Gives a view over the bytes of an array, wherever it starts in its buffer. */
function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
