import { equalBytes } from '@noble/curves/utils.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Compressor } from '../file/tasklace-file';
import { failure, success } from '../result';
import { AEAD_TAG_BYTES, type Aead } from '../collaboration/secure/channel';

const BYTE_VALUES = 256;
const XORSHIFT_LEFT = 13;
const XORSHIFT_RIGHT = 17;
const XORSHIFT_LAST = 5;

/** Computes the tag of the test cipher over a key, a nonce and plain bytes. */
function tagOf(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array): Uint8Array {
  return hmac.create(sha256, key).update(nonce).update(plain).digest().subarray(0, AEAD_TAG_BYTES);
}

/** Stands for AES-GCM in the core, where Node is not allowed: the plain bytes followed by a tag over the key, the nonce and the bytes, which is enough to see that a change or a wrong key is refused, the real cipher being tested in main. */
export const testAead: Aead = {
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

/** Leaves the bytes as they are, refusing what goes beyond the limit, to follow what is done with each result. */
export const plainCompression: Compressor = {
  compress: (bytes) => Uint8Array.from(bytes),
  decompress: (bytes, maxBytes) =>
    bytes.length > maxBytes ? failure('OUTPUT_TOO_LARGE') : success(Uint8Array.from(bytes)),
};

/** Gives a random source drawn from a seed by xorshift, so that draws never repeat in a test and every run draws the same bytes. */
export function seededRandom(seed = 1): (count: number) => Uint8Array {
  let state = seed >>> 0 || 1;
  return (count) =>
    Uint8Array.from({ length: count }, () => {
      state ^= state << XORSHIFT_LEFT;
      state ^= state >>> XORSHIFT_RIGHT;
      state ^= state << XORSHIFT_LAST;
      state >>>= 0;
      return state % BYTE_VALUES;
    });
}
