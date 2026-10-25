import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { verifierOf } from './signature.ts';

const RFC_8032_PUBLIC_KEY = hexToBytes(
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
);
const RFC_8032_EMPTY_SIGNATURE = hexToBytes(
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
);
const SMALL_ORDER_KEYS = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map(hexToBytes);

/** Makes the signature whose point is a given encoding and whose scalar is zero, the forgery a key of small order would let pass. */
function forgedSignature(point: Uint8Array): Uint8Array {
  const signature = new Uint8Array(64);
  signature.set(point);
  return signature;
}

describe('the signatures the relay checks', () => {
  it('accepts the signature of the first example of RFC 8032 and nothing else for it', () => {
    const verify = verifierOf(RFC_8032_PUBLIC_KEY);
    const altered = RFC_8032_EMPTY_SIGNATURE.slice();
    altered[0] = (altered[0] ?? 0) ^ 1;
    expect([
      verify?.(new Uint8Array(), RFC_8032_EMPTY_SIGNATURE),
      verify?.(Uint8Array.of(0), RFC_8032_EMPTY_SIGNATURE),
      verify?.(new Uint8Array(), altered),
      verify?.(new Uint8Array(), RFC_8032_EMPTY_SIGNATURE.subarray(0, 63)),
    ]).toEqual([true, false, false, false]);
  });

  it('lets no forgery through for a key of small order, so that a stranger can never write into such a room', () => {
    const passed = SMALL_ORDER_KEYS.flatMap((key) =>
      [...SMALL_ORDER_KEYS, new Uint8Array(32)].map(
        (point) => verifierOf(key)?.(Uint8Array.of(1, 2, 3), forgedSignature(point)) ?? false,
      ),
    );
    expect(passed.filter(Boolean)).toEqual([]);
  });

  it('refuses bytes that are not the length of a key', () => {
    expect([verifierOf(new Uint8Array(31)), verifierOf(new Uint8Array(33))]).toEqual([null, null]);
  });

  it('decides as the strict check of the members does, for genuine and altered signatures', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ maxLength: 64 }),
        fc.nat({ max: 63 }),
        fc.boolean(),
        (seed, message, at, alter) => {
          const publicKey = ed25519.getPublicKey(seed);
          const signature = ed25519.sign(message, seed);
          if (alter) {
            signature[at] = (signature[at] ?? 0) ^ 1;
          }
          const strict = ed25519.verify(signature, message, publicKey, { zip215: false });
          expect(verifierOf(publicKey)?.(message, signature)).toBe(strict);
        },
      ),
    );
  });
});
