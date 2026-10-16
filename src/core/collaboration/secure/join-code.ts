export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 6;
export const WRONG_CODES_BEFORE_NEW_CODE = 5;

const ALPHABET_MASK = JOIN_CODE_ALPHABET.length - 1;
const JOIN_CODE_PATTERN = new RegExp(`^[${JOIN_CODE_ALPHABET}]{${String(JOIN_CODE_LENGTH)}}$`);
const SEPARATORS = /[\s-]/g;

/** Draws a join code of six characters from an alphabet without 0, O, 1 or I, each random byte giving one character without bias since the alphabet holds 32 of them. */
export function generateJoinCode(randomBytes: (count: number) => Uint8Array): string {
  return [...randomBytes(JOIN_CODE_LENGTH)]
    .map((byte) => JOIN_CODE_ALPHABET.charAt(byte & ALPHABET_MASK))
    .join('');
}

/** Reads a join code as a person types it, in either case and with spaces or hyphens, or returns null when it is not one. */
export function readJoinCode(text: string): string | null {
  const code = text.replace(SEPARATORS, '').toUpperCase();
  return JOIN_CODE_PATTERN.test(code) ? code : null;
}
