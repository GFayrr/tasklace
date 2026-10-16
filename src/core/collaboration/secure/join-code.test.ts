import { describe, expect, it } from 'vitest';
import { generateJoinCode, JOIN_CODE_ALPHABET, readJoinCode } from './join-code';

describe('join codes', () => {
  it('has 32 characters, none of 0, O, 1 or I', () => {
    expect([JOIN_CODE_ALPHABET.length, /[0O1I]/.test(JOIN_CODE_ALPHABET)]).toEqual([32, false]);
  });

  it('draws one character per random byte, the five lowest bits choosing it', () => {
    expect(generateJoinCode(() => Uint8Array.of(0, 31, 32, 255, 9, 130))).toBe('A9A9KC');
  });

  it('reads a code typed in either case, with spaces or hyphens, and refuses anything else', () => {
    expect(
      ['k7q4mz', 'K7Q-4MZ', ' k7q 4mz ', 'K7Q4M', 'K7Q4MZZ', 'K7Q4M0', 'K7Q4MI'].map(readJoinCode),
    ).toEqual(['K7Q4MZ', 'K7Q4MZ', 'K7Q4MZ', null, null, null, null]);
  });
});
