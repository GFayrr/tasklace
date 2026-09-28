import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Compressor } from '../../src/core/file/tasklace-file';
import { crc32 } from '../../src/core/file/crc32';
import { failure, success } from '../../src/core/result';

const SMALLEST_OUTPUT_LIMIT = 1;
const FAST_COMPRESSION_LEVEL = 1;
const HEADER_BYTES = 16;
const CHECKSUM_OFFSET = 8;
const DECLARED_SIZE_OFFSET = 12;

/** Compresses with fast raw deflate (level 1) and decompresses with a hard output limit, as the main process will. */
export const zlibCompressor: Compressor = {
  compress: (bytes) => new Uint8Array(deflateRawSync(bytes, { level: FAST_COMPRESSION_LEVEL })),
  decompress: (bytes, maxOutputBytes) => {
    try {
      const output = inflateRawSync(bytes, {
        maxOutputLength: Math.max(maxOutputBytes, SMALLEST_OUTPUT_LIMIT),
      });
      return success(new Uint8Array(output));
    } catch (error) {
      const tooLarge =
        error instanceof RangeError && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE';
      return failure(tooLarge ? 'OUTPUT_TOO_LARGE' : 'INVALID_DATA');
    }
  },
};

/** Builds a file around a payload with a chosen declared size and a correct checksum, as an attacker would. */
export function forgeFile(
  header: Uint8Array,
  payload: Uint8Array,
  declaredSize: number,
): Uint8Array {
  const file = new Uint8Array(HEADER_BYTES + payload.length);
  file.set(header.subarray(0, HEADER_BYTES), 0);
  file.set(payload, HEADER_BYTES);
  const view = new DataView(file.buffer);
  view.setUint32(DECLARED_SIZE_OFFSET, declaredSize, true);
  view.setUint32(CHECKSUM_OFFSET, crc32(file.subarray(DECLARED_SIZE_OFFSET)), true);
  return file;
}
