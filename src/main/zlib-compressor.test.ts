import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zlibCompressor } from './zlib-compressor';

const TEXT = new TextEncoder().encode('Tasklace '.repeat(1_000));

describe('zlibCompressor', () => {
  it('gives back exactly what it compressed', () => {
    const compressed = zlibCompressor.compress(TEXT);
    expect(compressed.length).toBeLessThan(TEXT.length);
    const restored = zlibCompressor.decompress(compressed, TEXT.length);
    expect(restored.ok && Uint8Array.from(restored.value)).toEqual(TEXT);
  });

  it('refuses an output larger than its limit', () => {
    const compressed = zlibCompressor.compress(TEXT);
    expect(zlibCompressor.decompress(compressed, TEXT.length - 1)).toEqual({
      ok: false,
      error: 'OUTPUT_TOO_LARGE',
    });
  });

  it('refuses bytes that are not deflate data, a cut stream and bytes after its end', () => {
    const compressed = zlibCompressor.compress(TEXT);
    const invalid = { ok: false, error: 'INVALID_DATA' };
    expect(zlibCompressor.decompress(Uint8Array.from([0xff, 0xff, 0xff]), TEXT.length)).toEqual(
      invalid,
    );
    expect(zlibCompressor.decompress(compressed.subarray(0, 10), TEXT.length)).toEqual(invalid);
    const followed = new Uint8Array([...compressed, 1, 2, 3]);
    expect(zlibCompressor.decompress(followed, TEXT.length)).toEqual(invalid);
  });

  it('compresses at the fast level', () => {
    expect(Uint8Array.from(zlibCompressor.compress(TEXT))).toEqual(
      Uint8Array.from(deflateRawSync(TEXT, { level: 1 })),
    );
  });
});
