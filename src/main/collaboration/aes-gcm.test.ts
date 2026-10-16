import { describe, expect, it } from 'vitest';
import { AEAD_TAG_BYTES, NONCE_BYTES } from '../../core/collaboration/secure/channel';
import { aesGcm, systemRandomBytes } from './aes-gcm';

const KEY = new Uint8Array(32).fill(7);
const NONCE = new Uint8Array(NONCE_BYTES);

describe('AES-256-GCM for the encrypted channel', () => {
  it('matches the first test of the authors of GCM for a 256-bit key', () => {
    const sealed = aesGcm.seal(new Uint8Array(32), new Uint8Array(NONCE_BYTES), new Uint8Array(16));
    expect(Buffer.from(sealed).toString('hex')).toBe(
      'cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919',
    );
  });

  it('opens what it sealed, the tag after the encrypted bytes', () => {
    const sealed = aesGcm.seal(KEY, NONCE, Uint8Array.of(1, 2, 3));
    expect(sealed).toHaveLength(3 + AEAD_TAG_BYTES);
    expect(aesGcm.open(KEY, NONCE, sealed)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('gives null for a frame changed, sealed with another nonce or key, or shorter than a tag', () => {
    const sealed = aesGcm.seal(KEY, NONCE, Uint8Array.of(1, 2, 3));
    const changed = Uint8Array.from(sealed);
    changed[0] = (changed[0] ?? 0) ^ 1;
    const otherNonce = Uint8Array.from(NONCE);
    otherNonce[11] = 1;
    expect([
      aesGcm.open(KEY, NONCE, changed),
      aesGcm.open(KEY, otherNonce, sealed),
      aesGcm.open(new Uint8Array(32), NONCE, sealed),
      aesGcm.open(KEY, NONCE, new Uint8Array(AEAD_TAG_BYTES - 1)),
    ]).toEqual([null, null, null, null]);
  });

  it('throws on a key of the wrong size, which only a programming error gives', () => {
    expect(() => aesGcm.open(new Uint8Array(3), NONCE, new Uint8Array(AEAD_TAG_BYTES))).toThrow(
      'Invalid key length',
    );
  });

  it('draws the number of random bytes asked for', () => {
    expect(systemRandomBytes(32)).toHaveLength(32);
  });
});
