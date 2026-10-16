import { describe, expect, it, vi } from 'vitest';
import { failure, success } from '../../result';
import { openSecureChannel, type Aead } from './channel';
import type { Compressor } from '../../file/tasklace-file';
import type { SessionKeys } from './cpace';

const limits = vi.hoisted(() => ({ frames: 2, compressedBytes: 3 }));

vi.mock('../../limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../limits')>()),
  get MAX_CHANNEL_FRAMES() {
    return limits.frames;
  },
  get MAX_CHANNEL_COMPRESSED_BYTES() {
    return limits.compressedBytes;
  },
}));

const KEY = new Uint8Array(32);
const KEYS: SessionKeys = { send: KEY, receive: KEY, resume: KEY };
const clearAead: Aead = {
  seal: (_key, _nonce, plain) => plain,
  open: (_key, _nonce, sealed) => sealed,
};
const sameBytes: Compressor = {
  compress: (bytes) => bytes,
  decompress: (bytes) => success(bytes),
};

describe('the limits of the encrypted channel', () => {
  it('refuses to seal past its last frame number, and breaks when a frame comes past it', () => {
    const channel = openSecureChannel(KEYS, clearAead, sameBytes);
    expect(channel.seal(Uint8Array.of(1)).ok).toBe(true);
    expect(channel.seal(Uint8Array.of(2)).ok).toBe(true);
    expect(channel.seal(Uint8Array.of(3))).toEqual(failure('WORN_OUT'));
    expect([1, 2, 3].map((byte) => channel.open(Uint8Array.of(1, byte)))).toEqual([
      success(Uint8Array.of(1)),
      success(Uint8Array.of(2)),
      failure('WORN_OUT'),
    ]);
  });

  it('breaks when the frames of one message add up past the compressed limit', () => {
    const channel = openSecureChannel(KEYS, clearAead, sameBytes);
    expect(channel.open(Uint8Array.of(0, 1, 2, 3, 4))).toEqual(failure('TOO_LARGE'));
  });
});
