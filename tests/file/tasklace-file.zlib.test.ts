import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  encodeTasklaceFile,
  HEADER_BYTES,
  openTasklaceFile,
  readTasklaceFile,
} from '../../src/core/file/tasklace-file';
import { createSharedDocument, readSharedData } from '../../src/core/shared/shared-document';
import { PROPERTY_TEST_TIMEOUT_MS } from '../../src/core/testing/arbitraries';
import { buildLargeProject } from '../fixtures/large-project';
import { forgeFile, zlibCompressor } from './zlib-compressor';

const MEBIBYTE = 1_024 * 1_024;
const BOMB_MEBIBYTES = 64;
const DECLARED_MEBIBYTES = 1;

/** Returns the error code of reading a file with real compression, or 'ok' when it is accepted. */
function readCode(file: Uint8Array): string {
  const read = readTasklaceFile(file, zlibCompressor);
  return read.ok ? 'ok' : read.error.code;
}

describe('tasklace file with real compression', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  const document = createSharedDocument(buildLargeProject());
  const file = encodeTasklaceFile(document, zlibCompressor);

  it('reads back the large project unchanged and opens a session on it', () => {
    const read = readTasklaceFile(file, zlibCompressor);
    expect(read.ok && readSharedData(read.value)).toEqual(readSharedData(document));
    expect(openTasklaceFile(file, zlibCompressor).ok).toBe(true);
  });

  it('stops a decompression bomb at the declared size, even with a correct checksum', () => {
    const bomb = deflateRawSync(new Uint8Array(BOMB_MEBIBYTES * MEBIBYTE));
    expect(bomb.length).toBeLessThan(MEBIBYTE);
    expect(readCode(forgeFile(file, bomb, DECLARED_MEBIBYTES * MEBIBYTE))).toBe(
      'DECOMPRESSION_BOMB',
    );
  });

  it('refuses a damaged compressed stream with a correct checksum', () => {
    const damaged = Uint8Array.from(file.subarray(HEADER_BYTES));
    damaged.fill(0xff, 0, 8);
    const stateSize = Y.encodeStateAsUpdate(document).length;
    expect(readCode(forgeFile(file, damaged, stateSize))).toBe('DECOMPRESSION_FAILED');
  });

  it('refuses bytes after the end of the compressed stream, and a stream cut short', () => {
    const payload = file.subarray(HEADER_BYTES);
    const stateSize = Y.encodeStateAsUpdate(document).length;
    const trailing = Uint8Array.from([...payload, 0]);
    expect(readCode(forgeFile(file, trailing, stateSize))).toBe('DECOMPRESSION_FAILED');
    const cut = payload.subarray(0, payload.length - 1);
    expect(readCode(forgeFile(file, cut, stateSize))).toBe('DECOMPRESSION_FAILED');
  });
});
