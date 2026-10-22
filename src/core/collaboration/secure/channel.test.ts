import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { equalBytes } from '@noble/curves/utils.js';
import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_CHUNK_BYTES, MAX_COLLABORATION_MESSAGE_BYTES } from '../../limits';
import { failure, success } from '../../result';
import {
  AEAD_TAG_BYTES,
  MAX_SEALED_FRAME_BYTES,
  openSecureChannel,
  type Aead,
  type ChannelKind,
} from './channel';
import type { Compressor } from '../../file/tasklace-file';
import type { SessionKeys } from './cpace';

const HOST_TO_GUEST = new Uint8Array(32).fill(1);
const GUEST_TO_HOST = new Uint8Array(32).fill(2);
const HOST_KEYS: SessionKeys = {
  send: HOST_TO_GUEST,
  receive: GUEST_TO_HOST,
  resume: new Uint8Array(32),
};
const GUEST_KEYS: SessionKeys = {
  send: GUEST_TO_HOST,
  receive: HOST_TO_GUEST,
  resume: new Uint8Array(32),
};

/** Computes the tag of the test cipher over a nonce and plain bytes. */
function tagOf(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array): Uint8Array {
  return hmac.create(sha256, key).update(nonce).update(plain).digest().subarray(0, AEAD_TAG_BYTES);
}
/** Stands for AES-GCM in the core, where Node is not allowed: the plain bytes followed by a tag over the nonce and the bytes, which is enough to see that the channel refuses any change, the real cipher being tested in main. */

const testAead: Aead = {
  seal: (key, nonce, plain) => {
    const sealedBytes = new Uint8Array(plain.length + AEAD_TAG_BYTES);
    sealedBytes.set(plain);
    sealedBytes.set(tagOf(key, nonce, plain), plain.length);
    return sealedBytes;
  },
  open: (key, nonce, sealed) => {
    const plain = sealed.subarray(0, sealed.length - AEAD_TAG_BYTES);
    return sealed.length >= AEAD_TAG_BYTES &&
      equalBytes(tagOf(key, nonce, plain), sealed.subarray(plain.length))
      ? plain
      : null;
  },
};

/** Leaves the bytes as they are, refusing on demand, to follow what the channel does with each result. */
const plainCompression: Compressor = {
  compress: (bytes) => Uint8Array.from(bytes),
  decompress: (bytes, maxBytes) =>
    bytes.length > maxBytes ? failure('OUTPUT_TOO_LARGE') : success(Uint8Array.from(bytes)),
};

/** Opens the two ends of a channel. */
function ends(compression: Compressor = plainCompression) {
  return {
    host: openSecureChannel(HOST_KEYS, testAead, compression),
    guest: openSecureChannel(GUEST_KEYS, testAead, compression),
  };
}

/** Gives what the channel opens for a message of the plan. */
function plan(message: Uint8Array) {
  return success({ kind: 'plan', message });
}

/** Seals a message of the plan, or of another kind, failing the test when it is refused. */
function sealed(
  channel: ReturnType<typeof openSecureChannel>,
  message: Uint8Array,
  kind: ChannelKind = 'plan',
): readonly Uint8Array[] {
  const frames = channel.seal(message, kind);
  if (!frames.ok) {
    throw new Error(frames.error);
  }
  return frames.value;
}

describe('the encrypted channel', () => {
  it('carries messages both ways, in order', () => {
    const { host, guest } = ends();
    expect(sealed(host, Uint8Array.of(1, 2, 3)).map((frame) => guest.open(frame))).toEqual([
      plan(Uint8Array.of(1, 2, 3)),
    ]);
    expect(sealed(guest, new Uint8Array()).map((frame) => host.open(frame))).toEqual([
      plan(new Uint8Array()),
    ]);
    expect(sealed(host, Uint8Array.of(4)).map((frame) => guest.open(frame))).toEqual([
      plan(Uint8Array.of(4)),
    ]);
  });

  it('tells a key of the plan apart from a message of the plan', () => {
    const { host, guest } = ends();
    expect(sealed(host, Uint8Array.of(9), 'planKey').map((frame) => guest.open(frame))).toEqual([
      success({ kind: 'planKey', message: Uint8Array.of(9) }),
    ]);
  });

  it('breaks when the frames of one message are of different kinds', () => {
    const { guest } = ends();
    /** Builds the nonce of a frame number below 256. */
    const nonce = (counter: number) => {
      const bytes = new Uint8Array(12);
      bytes[11] = counter;
      return bytes;
    };
    expect(guest.open(testAead.seal(HOST_TO_GUEST, nonce(0), Uint8Array.of(0, 1)))).toEqual(
      success(null),
    );
    expect(guest.open(testAead.seal(HOST_TO_GUEST, nonce(1), Uint8Array.of(3, 1)))).toEqual(
      failure('TAMPERED'),
    );
  });

  it('cuts a large message into frames of one mebibyte and joins them back', () => {
    const { host, guest } = ends();
    const message = Uint8Array.from(
      { length: 2 * CHANNEL_CHUNK_BYTES + 5 },
      (_unused, index) => index % 251,
    );
    const frames = sealed(host, message);
    expect(frames.map((frame) => frame.length)).toEqual([
      MAX_SEALED_FRAME_BYTES,
      MAX_SEALED_FRAME_BYTES,
      1 + 5 + AEAD_TAG_BYTES,
    ]);
    const opened = frames.map((frame) => guest.open(frame));
    expect(opened.slice(0, 2)).toEqual([success(null), success(null)]);
    const last = opened[2];
    expect(
      last?.ok === true && last.value?.kind === 'plan' && equalBytes(last.value.message, message),
    ).toBe(true);
  });

  it('compresses before sealing and decompresses within the limit of a message', () => {
    const compress = vi.fn(() => Uint8Array.of(7));
    const decompress = vi.fn(() => success(Uint8Array.of(8, 9)));
    const { host, guest } = ends({ compress, decompress });
    expect(sealed(host, Uint8Array.of(1, 2)).map((frame) => guest.open(frame))).toEqual([
      plan(Uint8Array.of(8, 9)),
    ]);
    expect(compress.mock.calls).toEqual([[Uint8Array.of(1, 2)]]);
    expect(decompress.mock.calls).toEqual([[Uint8Array.of(7), MAX_COLLABORATION_MESSAGE_BYTES]]);
  });

  it('refuses to seal a message above the limit', () => {
    const { host } = ends();
    expect(
      host.seal({ length: MAX_COLLABORATION_MESSAGE_BYTES + 1 } as Uint8Array, 'plan'),
    ).toEqual(failure('TOO_LARGE'));
  });

  it.each([
    [
      'changed',
      (frames: readonly Uint8Array[]) => [
        Uint8Array.from(frames[0] ?? [], (byte, index) => (index === 0 ? byte ^ 1 : byte)),
      ],
    ],
    ['repeated', (frames: readonly Uint8Array[]) => [frames[0], frames[0]]],
    ['reordered', (frames: readonly Uint8Array[]) => [frames[1], frames[0]]],
    ['lost', (frames: readonly Uint8Array[]) => [frames[1]]],
    [
      'sealed for the other direction',
      (_frames: readonly Uint8Array[], back: readonly Uint8Array[]) => [back[0]],
    ],
  ])('breaks for good on a frame %s', (_label, tamper) => {
    const { host, guest } = ends();
    const frames = [...sealed(host, Uint8Array.of(1)), ...sealed(host, Uint8Array.of(2))];
    const back = sealed(guest, Uint8Array.of(3));
    const results = tamper(frames, back).map((frame) => guest.open(frame ?? new Uint8Array()));
    expect(results.find((result) => !result.ok)).toEqual(failure('TAMPERED'));
    expect(guest.open(frames[0] ?? new Uint8Array())).toEqual(failure('BROKEN'));
  });

  it('breaks on a frame too long to be one, an empty frame and a frame with an unknown header', () => {
    const tooLong = ends();
    expect(tooLong.guest.open(new Uint8Array(MAX_SEALED_FRAME_BYTES + 1))).toEqual(
      failure('TAMPERED'),
    );
    const empty = ends();
    const nonce = new Uint8Array(12);
    expect(empty.guest.open(testAead.seal(HOST_TO_GUEST, nonce, new Uint8Array()))).toEqual(
      failure('TAMPERED'),
    );
    const header = ends();
    expect(header.guest.open(testAead.seal(HOST_TO_GUEST, nonce, Uint8Array.of(4, 0)))).toEqual(
      failure('TAMPERED'),
    );
  });

  it('breaks when the message does not decompress, or decompresses above the limit', () => {
    const invalid = ends({ ...plainCompression, decompress: () => failure('INVALID_DATA') });
    expect(
      sealed(invalid.host, Uint8Array.of(1)).map((frame) => invalid.guest.open(frame)),
    ).toEqual([failure('INVALID_CONTENT')]);
    const large = ends({ ...plainCompression, decompress: () => failure('OUTPUT_TOO_LARGE') });
    expect(sealed(large.host, Uint8Array.of(1)).map((frame) => large.guest.open(frame))).toEqual([
      failure('TOO_LARGE'),
    ]);
    expect(large.guest.open(new Uint8Array())).toEqual(failure('BROKEN'));
  });
});
