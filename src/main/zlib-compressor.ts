import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Compressor, DecompressionErrorCode } from '../core/file/tasklace-file';
import { failure, success } from '../core/result';

const FAST_COMPRESSION_LEVEL = 1;
const INVALID_DATA_CODES: readonly unknown[] = ['Z_DATA_ERROR', 'Z_BUF_ERROR'];
const OUTPUT_TOO_LARGE_CODE = 'ERR_BUFFER_TOO_LARGE';

interface Inflated {
  readonly output: Uint8Array;
  readonly consumedBytes: number;
}

/** Compresses with fast raw deflate (level 1) and decompresses with a hard output limit, refusing bytes after the end of the stream, without copying the results. */
export const zlibCompressor: Compressor = {
  compress: (bytes) => deflateRawSync(bytes, { level: FAST_COMPRESSION_LEVEL }),
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
  return { output: buffer, consumedBytes };
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
