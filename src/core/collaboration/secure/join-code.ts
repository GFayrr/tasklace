declare const JOIN_CODE_BRAND: unique symbol;

export type JoinCode = string & { readonly [JOIN_CODE_BRAND]: true };

export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 6;
export const WRONG_CODES_BEFORE_NEW_CODE = 5;

const ALPHABET_MASK = JOIN_CODE_ALPHABET.length - 1;
const JOIN_CODE_PATTERN = new RegExp(`^[${JOIN_CODE_ALPHABET}]{${String(JOIN_CODE_LENGTH)}}$`);
const SEPARATORS = /[\s-]/g;

/** Draws a join code of six characters from an alphabet without 0, O, 1 or I, each random byte giving one character without bias since the alphabet holds 32 of them. */
export function generateJoinCode(randomBytes: (count: number) => Uint8Array): JoinCode {
  const code = [...randomBytes(JOIN_CODE_LENGTH)]
    .map((byte) => JOIN_CODE_ALPHABET.charAt(byte & ALPHABET_MASK))
    .join('');
  if (!isJoinCode(code)) {
    throw new RangeError(`Not a join code: ${code}`);
  }
  return code;
}

/** Reads a join code as a person types it, in either case and with spaces or hyphens, or returns null when it is not one. */
export function readJoinCode(text: string): JoinCode | null {
  const code = text.replace(SEPARATORS, '').toUpperCase();
  return isJoinCode(code) ? code : null;
}

/** Tells whether a value is a join code exactly as the host draws it: six characters of the alphabet, which never hold the colon that starts the password made from a key. */
export function isJoinCode(value: unknown): value is JoinCode {
  return typeof value === 'string' && JOIN_CODE_PATTERN.test(value);
}
