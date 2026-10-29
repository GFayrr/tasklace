const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BITS_PER_CHARACTER = 6;
const BITS_PER_BYTE = 8;
const CHARACTER_MASK = 0b111111;
const BYTE_MASK = 0xff;
const VALUES: ReadonlyMap<string, number> = new Map(
  Array.from(ALPHABET, (character, value) => [character, value]),
);

/** Writes bytes in the URL-safe base64 alphabet, without padding. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let text = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << BITS_PER_BYTE) | byte;
    bits += BITS_PER_BYTE;
    while (bits >= BITS_PER_CHARACTER) {
      bits -= BITS_PER_CHARACTER;
      text += ALPHABET.charAt((buffer >> bits) & CHARACTER_MASK);
    }
    buffer &= (1 << bits) - 1;
  }
  return bits === 0
    ? text
    : text + ALPHABET.charAt((buffer << (BITS_PER_CHARACTER - bits)) & CHARACTER_MASK);
}

/** Reads URL-safe base64 without padding, returning null for any character outside the alphabet, an impossible length or unused bits that are not zero, so that each byte string has one writing only. */
export function decodeBase64Url(text: string): Uint8Array | null {
  const bytes = new Uint8Array(Math.floor((text.length * BITS_PER_CHARACTER) / BITS_PER_BYTE));
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const character of text) {
    const value = VALUES.get(character);
    if (value === undefined) {
      return null;
    }
    buffer = (buffer << BITS_PER_CHARACTER) | value;
    bits += BITS_PER_CHARACTER;
    if (bits >= BITS_PER_BYTE) {
      bits -= BITS_PER_BYTE;
      bytes[at] = (buffer >> bits) & BYTE_MASK;
      at += 1;
    }
    buffer &= (1 << bits) - 1;
  }
  return bits >= BITS_PER_CHARACTER || buffer !== 0 ? null : bytes;
}
