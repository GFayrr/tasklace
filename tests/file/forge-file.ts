import { crc32 } from '../../src/core/file/crc32';

const HEADER_BYTES = 16;
const CHECKSUM_OFFSET = 8;
const DECLARED_SIZE_OFFSET = 12;

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
