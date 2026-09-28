import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Compressor, DecompressionErrorCode } from '../../src/core/file/tasklace-file';
import { crc32 } from '../../src/core/file/crc32';
import { failure, success } from '../../src/core/result';

const FAST_COMPRESSION_LEVEL = 1;
const HEADER_BYTES = 16;
const CHECKSUM_OFFSET = 8;
const DECLARED_SIZE_OFFSET = 12;
const INVALID_DATA_CODES: readonly unknown[] = ['Z_DATA_ERROR', 'Z_BUF_ERROR'];
const OUTPUT_TOO_LARGE_CODE = 'ERR_BUFFER_TOO_LARGE';

interface Inflated {
  readonly output: Uint8Array;
  readonly consumedBytes: number;
}

/** Compresses with fast raw deflate (level 1) and decompresses with a hard output limit, refusing bytes after the end of the stream. */
export const zlibCompressor: Compressor = {
  compress: (bytes) => new Uint8Array(deflateRawSync(bytes, { level: FAST_COMPRESSION_LEVEL })),
  decompress: (bytes, maxOutputBytes) => {
    try {
      const inflated = readInflated(
        inflateRawSync(bytes, { info: true, maxOutputLength: maxOutputBytes }),
      );
      return inflated.consumedBytes === bytes.length
        ? success(inflated.output)
        : failure('INVALID_DATA');
    } catch (error) {
      return failure(decompressionErrorCode(error));
    }
  },
};

/** Reads the output and the number of compressed bytes consumed from what zlib returns when asked for details. */
function readInflated(result: unknown): Inflated {
  const buffer: unknown = Reflect.get(Object(result), 'buffer');
  const consumedBytes: unknown = Reflect.get(
    Object(Reflect.get(Object(result), 'engine')),
    'bytesWritten',
  );
  if (!(buffer instanceof Uint8Array) || typeof consumedBytes !== 'number') {
    throw new TypeError('Unexpected result from zlib');
  }
  return { output: new Uint8Array(buffer), consumedBytes };
}

/** Maps a zlib error on untrusted data to a decompression error code, rethrowing any other error. */
function decompressionErrorCode(error: unknown): DecompressionErrorCode {
  const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;
  if (code === OUTPUT_TOO_LARGE_CODE) {
    return 'OUTPUT_TOO_LARGE';
  }
  if (INVALID_DATA_CODES.includes(code)) {
    return 'INVALID_DATA';
  }
  throw error;
}

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
