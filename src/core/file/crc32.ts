const CRC32_POLYNOMIAL = 0xedb88320;
const BYTE_VALUES = 256;
const BITS_PER_BYTE = 8;
const BYTE_MASK = 0xff;
const ALL_BITS = 0xffffffff;

const CRC32_TABLE = buildTable();

/** Computes the CRC-32 (IEEE 802.3) checksum of some bytes as an unsigned 32-bit number. */
export function crc32(bytes: Uint8Array): number {
  let crc = ALL_BITS;
  for (const byte of bytes) {
    crc = (CRC32_TABLE[(crc ^ byte) & BYTE_MASK] ?? 0) ^ (crc >>> BITS_PER_BYTE);
  }
  return (crc ^ ALL_BITS) >>> 0;
}

/** Precomputes the checksum contribution of every possible byte value. */
function buildTable(): Uint32Array {
  const table = new Uint32Array(BYTE_VALUES);
  for (let value = 0; value < BYTE_VALUES; value += 1) {
    table[value] = shiftByte(value);
  }
  return table;
}

/** Runs the eight polynomial division steps of one byte value. */
function shiftByte(value: number): number {
  let crc = value;
  for (let bit = 0; bit < BITS_PER_BYTE; bit += 1) {
    crc = crc & 1 ? CRC32_POLYNOMIAL ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
}
