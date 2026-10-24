import {
  CHANNEL_CHUNK_BYTES,
  MAX_CHANNEL_COMPRESSED_BYTES,
  MAX_CHANNEL_FRAMES,
  MAX_COLLABORATION_MESSAGE_BYTES,
} from '../../limits';
import { failure, success, type Result } from '../../result';
import type { Compressor } from '../../file/tasklace-file';
import type { SessionKeys } from './cpace';

export interface Aead {
  readonly seal: (key: Uint8Array, nonce: Uint8Array, plain: Uint8Array) => Uint8Array;
  readonly open: (key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array) => Uint8Array | null;
}

export type SealRefusal = 'TOO_LARGE' | 'WORN_OUT';
export type ChannelBreak = 'TAMPERED' | 'TOO_LARGE' | 'INVALID_CONTENT' | 'WORN_OUT' | 'BROKEN';

export type ChannelKind = 'plan' | 'planKey' | 'identity';

export interface ChannelMessage {
  readonly kind: ChannelKind;
  readonly message: Uint8Array;
}

export interface SecureChannel {
  readonly seal: (
    message: Uint8Array,
    kind: ChannelKind,
  ) => Result<readonly Uint8Array[], SealRefusal>;
  readonly sealCompressed: (
    compressed: CompressedMessage,
  ) => Result<readonly Uint8Array[], SealRefusal>;
  readonly open: (frame: Uint8Array) => Result<ChannelMessage | null, ChannelBreak>;
  readonly allowMessagesUpTo: (bytes: number) => void;
}

export interface CompressedMessage {
  readonly kind: ChannelKind;
  readonly bytes: Uint8Array;
}

export const NONCE_BYTES = 12;
export const AEAD_TAG_BYTES = 16;
export const FRAME_HEADER_BYTES = 1;
export const MAX_SEALED_FRAME_BYTES = FRAME_HEADER_BYTES + CHANNEL_CHUNK_BYTES + AEAD_TAG_BYTES;

const COUNTER_OFFSET = NONCE_BYTES - BigUint64Array.BYTES_PER_ELEMENT;
const LAST_FRAME_BIT = 1;
const PLAN_KEY_BIT = 2;
const IDENTITY_BIT = 4;
const KIND_BITS = PLAN_KEY_BIT | IDENTITY_BIT;
const KNOWN_HEADER_BITS = LAST_FRAME_BIT | KIND_BITS;
const KIND_OF_BITS: ReadonlyMap<number, ChannelKind> = new Map([
  [0, 'plan'],
  [PLAN_KEY_BIT, 'planKey'],
  [IDENTITY_BIT, 'identity'],
]);
const BITS_OF_KIND: Readonly<Record<ChannelKind, number>> = {
  plan: 0,
  planKey: PLAN_KEY_BIT,
  identity: IDENTITY_BIT,
};

/** Opens an encrypted channel over the keys of a handshake: each message is compressed, cut into frames of one mebibyte telling its kind and sealed with a counter as nonce, a frame changed, lost, repeated or reordered, or too large, breaking it. */
export function openSecureChannel(
  keys: SessionKeys,
  aead: Aead,
  compression: Compressor,
  messageLimit = MAX_COLLABORATION_MESSAGE_BYTES,
): SecureChannel {
  let limit = messageLimit;
  let sent = 0;
  let received = 0;
  let broken = false;
  let parts: Uint8Array[] = [];
  let partBytes = 0;
  let partKind: ChannelKind | null = null;
  /** Marks the channel as broken and returns why. */
  const breakWith = (reason: ChannelBreak): Result<never, ChannelBreak> => {
    broken = true;
    parts = [];
    partKind = null;
    return failure(reason);
  };
  /** Joins the frames of a message once its last one came, then decompresses it. */
  const finish = (kind: ChannelKind): Result<ChannelMessage, ChannelBreak> => {
    const joined = concat(parts, partBytes);
    parts = [];
    partBytes = 0;
    partKind = null;
    const message = compression.decompress(joined, limit);
    if (message.ok) {
      return success({ kind, message: message.value });
    }
    return breakWith(message.error === 'OUTPUT_TOO_LARGE' ? 'TOO_LARGE' : 'INVALID_CONTENT');
  };
  /** Cuts a compressed message into frames and seals each with the next counter, refusing once the counter would run out. */
  const sealFrames = ({
    kind,
    bytes,
  }: CompressedMessage): Result<readonly Uint8Array[], SealRefusal> => {
    const chunks = chunksOf(bytes);
    if (sent + chunks.length > MAX_CHANNEL_FRAMES) {
      return failure('WORN_OUT');
    }
    return success(
      chunks.map((chunk, index) => {
        const plain = new Uint8Array(FRAME_HEADER_BYTES + chunk.length);
        plain[0] = headerOf(kind, index === chunks.length - 1);
        plain.set(chunk, FRAME_HEADER_BYTES);
        const frame = aead.seal(keys.send, nonceOf(sent), plain);
        sent += 1;
        return frame;
      }),
    );
  };
  return {
    seal: (message, kind) => {
      const compressed = compressMessage(message, kind, compression);
      return compressed.ok ? sealFrames(compressed.value) : compressed;
    },
    sealCompressed: (compressed) => sealFrames(compressed),
    open: (frame) => {
      if (broken) {
        return failure('BROKEN');
      }
      if (received >= MAX_CHANNEL_FRAMES) {
        return breakWith('WORN_OUT');
      }
      const plain =
        frame.length > MAX_SEALED_FRAME_BYTES
          ? null
          : aead.open(keys.receive, nonceOf(received), frame);
      received += 1;
      const header = plain?.[0];
      const kind = header === undefined ? undefined : KIND_OF_BITS.get(header & KIND_BITS);
      if (
        plain === null ||
        header === undefined ||
        (header & ~KNOWN_HEADER_BITS) !== 0 ||
        kind === undefined
      ) {
        return breakWith('TAMPERED');
      }
      if (partKind !== null && partKind !== kind) {
        return breakWith('TAMPERED');
      }
      partKind = kind;
      partBytes += plain.length - FRAME_HEADER_BYTES;
      if (partBytes > Math.min(MAX_CHANNEL_COMPRESSED_BYTES, limit + CHANNEL_CHUNK_BYTES)) {
        return breakWith('TOO_LARGE');
      }
      parts.push(plain.subarray(FRAME_HEADER_BYTES));
      return (header & LAST_FRAME_BIT) === 0 ? success(null) : finish(kind);
    },
    allowMessagesUpTo: (bytes) => {
      limit = Math.max(limit, Math.min(bytes, MAX_COLLABORATION_MESSAGE_BYTES));
    },
  };
}

/** Compresses a message once, so that it can be sealed for several channels, refusing a message above the limit. */
export function compressMessage(
  message: Uint8Array,
  kind: ChannelKind,
  compression: Compressor,
): Result<CompressedMessage, 'TOO_LARGE'> {
  if (message.length > MAX_COLLABORATION_MESSAGE_BYTES) {
    return failure('TOO_LARGE');
  }
  return success({ kind, bytes: compression.compress(message) });
}

/** Writes the header of a frame: the kind of its message and whether it is the last frame of it. */
function headerOf(kind: ChannelKind, isLast: boolean): number {
  return BITS_OF_KIND[kind] | (isLast ? LAST_FRAME_BIT : 0);
}

/** Builds the nonce of a frame from its number, the two directions never sharing a key. */
function nonceOf(counter: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  new DataView(nonce.buffer).setBigUint64(COUNTER_OFFSET, BigInt(counter));
  return nonce;
}

/** Cuts compressed bytes into chunks of at most one mebibyte, always at least one. */
function chunksOf(bytes: Uint8Array): Uint8Array[] {
  const count = Math.max(1, Math.ceil(bytes.length / CHANNEL_CHUNK_BYTES));
  return Array.from({ length: count }, (_unused, index) =>
    bytes.subarray(index * CHANNEL_CHUNK_BYTES, (index + 1) * CHANNEL_CHUNK_BYTES),
  );
}

/** Joins chunks into one array of a known length. */
function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}
