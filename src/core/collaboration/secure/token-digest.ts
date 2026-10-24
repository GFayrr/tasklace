declare const TOKEN_DIGEST_BRAND: unique symbol;

export type TokenDigest = string & { readonly [TOKEN_DIGEST_BRAND]: true };

const TOKEN_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Tells whether a value is the digest of the token of a person: sixty-four lowercase hexadecimal digits, checked without any hashing so that the bridge of the page can use it too. */
export function isTokenDigest(value: unknown): value is TokenDigest {
  return typeof value === 'string' && TOKEN_DIGEST_PATTERN.test(value);
}

/** Gives a value known to be the digest of a token, such as one just computed, as one, throwing for any other value since only a programming error can give one. */
export function requireTokenDigest(value: unknown): TokenDigest {
  if (!isTokenDigest(value)) {
    throw new TypeError(`Not the digest of a token: ${String(value)}`);
  }
  return value;
}
