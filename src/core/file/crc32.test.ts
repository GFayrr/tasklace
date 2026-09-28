import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32';

/** Encodes a text as UTF-8 bytes. */
function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('crc32', () => {
  it.each([
    ['', 0x00000000],
    ['a', 0xe8b7be43],
    ['123456789', 0xcbf43926],
    ['The quick brown fox jumps over the lazy dog', 0x414fa339],
  ])('gives the reference checksum of %j', (text, expected) => {
    expect(crc32(bytesOf(text))).toBe(expected);
  });

  it('changes when a single bit changes', () => {
    const bytes = bytesOf('Tasklace');
    const flipped = Uint8Array.from(bytes);
    flipped[3] = (flipped[3] ?? 0) ^ 1;
    expect(crc32(flipped)).not.toBe(crc32(bytes));
  });
});
