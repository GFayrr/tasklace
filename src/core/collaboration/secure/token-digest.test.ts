import { testToken } from '../../testing/secrets';
import { describe, expect, it } from 'vitest';
import { tokenDigestOf } from './link';
import { isTokenDigest, requireTokenDigest } from './token-digest';

describe('the digest of the token of a person', () => {
  it('gives the SHA-256 of the token in lowercase hexadecimal digits, which it then recognises', () => {
    const digest = tokenDigestOf(testToken('ab'.repeat(32)));
    expect([digest, isTokenDigest(digest)]).toEqual([
      '271a413bd339c5709fdceaec41f14f11e9fbfb5042d72d331c65f32b284cd09a',
      true,
    ]);
  });

  it('recognises no other value as a digest', () => {
    expect(['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 64, null].map(isTokenDigest)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(() => requireTokenDigest('abc')).toThrow(
      new TypeError('Not the digest of a token: abc'),
    );
  });
});
