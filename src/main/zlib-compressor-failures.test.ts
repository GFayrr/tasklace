import { afterEach, describe, expect, it, vi } from 'vitest';

const inflate = vi.hoisted(() => vi.fn());

vi.mock('node:zlib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:zlib')>()),
  inflateRawSync: inflate,
}));

const { zlibCompressor } = await import('./zlib-compressor');

afterEach(() => {
  inflate.mockReset();
});

describe('zlibCompressor facing an unexpected zlib', () => {
  it('lets an answer of an unexpected shape through as an error', () => {
    inflate.mockReturnValue({ buffer: 'not bytes', engine: {} });
    expect(() => zlibCompressor.decompress(Uint8Array.from([1]), 10)).toThrow(TypeError);
  });

  it('lets a zlib error it does not know through', () => {
    inflate.mockImplementation(() => {
      throw Object.assign(new Error('memory'), { code: 'Z_MEM_ERROR' });
    });
    expect(() => zlibCompressor.decompress(Uint8Array.from([1]), 10)).toThrow('memory');
  });

  it('lets a failure that is not an error through', () => {
    const failure: unknown = 'broken';
    inflate.mockImplementation(() => {
      throw failure;
    });
    expect(() => zlibCompressor.decompress(Uint8Array.from([1]), 10)).toThrow('broken');
  });
});
