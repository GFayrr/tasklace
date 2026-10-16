const TOKEN_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Tells whether a value is the digest of the token of a person: sixty-four lowercase hexadecimal digits, checked without any hashing so that the bridge of the page can use it too. */
export function isTokenDigest(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_DIGEST_PATTERN.test(value);
}
