import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64Url } from './base64url';

const ENCODER = new TextEncoder();

describe('URL-safe base64', () => {
  it('writes the examples of RFC 4648 without their padding', () => {
    expect(
      ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar'].map((text) =>
        encodeBase64Url(ENCODER.encode(text)),
      ),
    ).toEqual(['', 'Zg', 'Zm8', 'Zm9v', 'Zm9vYg', 'Zm9vYmE', 'Zm9vYmFy']);
  });

  it('uses - and _ where base64 uses + and /', () => {
    expect(encodeBase64Url(Uint8Array.of(0xfb, 0xff, 0xbf))).toBe('-_-_');
  });

  it('reads back any bytes it wrote', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 96 }), (bytes) => {
        expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
      }),
    );
  });

  it('refuses a character outside the alphabet, a padding, a length no bytes give and unused bits that are not zero', () => {
    expect(
      ['Zm9v+', 'Zm9v/', 'Zm8=', 'Zm9vY', 'Zh', 'Zm9', 'Zm€v', 'Zm😀v'].map(decodeBase64Url),
    ).toEqual([null, null, null, null, null, null, null, null]);
  });
});
