import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_CHUNK_BYTES, MAX_COLLABORATION_MESSAGE_BYTES } from '../../limits';
import { failure, success } from '../../result';
import {
  AEAD_TAG_BYTES,
  MAX_SEALED_FRAME_BYTES,
  compressMessage,
  openSecureChannel,
  type ChannelKind,
} from './channel';
import type { Compressor } from '../../file/tasklace-file';
import { plainCompression, testAead } from '../../testing/test-crypto';
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

  it('tells a key of the plan and an identity apart from a message of the plan', () => {
    const { host, guest } = ends();
    expect(sealed(host, Uint8Array.of(9), 'planKey').map((frame) => guest.open(frame))).toEqual([
      success({ kind: 'planKey', message: Uint8Array.of(9) }),
    ]);
    expect(sealed(host, Uint8Array.of(8), 'identity').map((frame) => guest.open(frame))).toEqual([
      success({ kind: 'identity', message: Uint8Array.of(8) }),
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
    const received = last?.ok === true && last.value !== null ? last.value : last;
    expect(
      received !== undefined && 'kind' in received
        ? { kind: received.kind, digest: bytesToHex(sha256(received.message)) }
        : received,
    ).toEqual({ kind: 'plan', digest: bytesToHex(sha256(message)) });
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

  it('decompresses no further than the limit it was opened with, until it is allowed larger messages, never smaller', () => {
    const decompress = vi.fn((bytes: Uint8Array, maxBytes: number) =>
      bytes.length > maxBytes ? failure('OUTPUT_TOO_LARGE' as const) : success(bytes),
    );
    const compression = { compress: (bytes: Uint8Array) => bytes, decompress };
    const host = openSecureChannel(HOST_KEYS, testAead, compression);
    const guest = openSecureChannel(GUEST_KEYS, testAead, compression, 4);
    expect(sealed(host, Uint8Array.of(1, 2, 3, 4)).map((frame) => guest.open(frame))).toEqual([
      plan(Uint8Array.of(1, 2, 3, 4)),
    ]);
    guest.allowMessagesUpTo(2);
    guest.allowMessagesUpTo(MAX_COLLABORATION_MESSAGE_BYTES + 1);
    expect(decompress.mock.calls.map(([, maxBytes]) => maxBytes)).toEqual([4]);
    expect(sealed(host, Uint8Array.of(5)).map((frame) => guest.open(frame))).toEqual([
      plan(Uint8Array.of(5)),
    ]);
    expect(decompress.mock.calls.map(([, maxBytes]) => maxBytes)).toEqual([
      4,
      MAX_COLLABORATION_MESSAGE_BYTES,
    ]);
    const fresh = openSecureChannel(HOST_KEYS, testAead, compression);
    const small = openSecureChannel(GUEST_KEYS, testAead, compression, 4);
    expect(sealed(fresh, Uint8Array.of(1, 2, 3, 4, 5)).map((frame) => small.open(frame))).toEqual([
      failure('TOO_LARGE'),
    ]);
  });

  it('stops gathering the frames of a message once they hold more than its limit and one frame', () => {
    const { host } = ends();
    const guest = openSecureChannel(GUEST_KEYS, testAead, plainCompression, 1);
    const frames = sealed(host, new Uint8Array(CHANNEL_CHUNK_BYTES + 2));
    expect(frames.map((frame) => guest.open(frame))).toEqual([success(null), failure('TOO_LARGE')]);
  });

  it('seals a message compressed once for several channels, which each open it', () => {
    const first = ends();
    const second = ends();
    const compressed = compressMessage(Uint8Array.of(1, 2), 'plan', plainCompression);
    if (!compressed.ok) {
      throw new Error(compressed.error);
    }
    const opened = [first, second].map(({ host, guest }) => {
      const frames = host.sealCompressed(compressed.value);
      return frames.ok ? frames.value.map((frame) => guest.open(frame)) : frames;
    });
    expect(opened).toEqual([[plan(Uint8Array.of(1, 2))], [plan(Uint8Array.of(1, 2))]]);
    expect(
      compressMessage(
        { length: MAX_COLLABORATION_MESSAGE_BYTES + 1 } as Uint8Array,
        'plan',
        plainCompression,
      ),
    ).toEqual(failure('TOO_LARGE'));
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
    expect(header.guest.open(testAead.seal(HOST_TO_GUEST, nonce, Uint8Array.of(8, 0)))).toEqual(
      failure('TAMPERED'),
    );
    const twoKinds = ends();
    expect(twoKinds.guest.open(testAead.seal(HOST_TO_GUEST, nonce, Uint8Array.of(7, 0)))).toEqual(
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
