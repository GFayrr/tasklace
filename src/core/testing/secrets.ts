import { isJoinCode, type JoinCode } from '../collaboration/secure/join-code';
import {
  readPlanKey,
  requireRejoinToken,
  type PlanKey,
  type RejoinToken,
} from '../collaboration/secure/link';
import { requireTokenDigest, type TokenDigest } from '../collaboration/secure/token-digest';
import type { RelayVerifyKey } from '../collaboration/relay/relay-keys';

/** Gives bytes a test uses as the key of a plan, failing the test when they do not have its length. */
export function testPlanKey(bytes: Uint8Array): PlanKey {
  const key = readPlanKey(bytes);
  if (key === null) {
    throw new RangeError(`Not the length of a key: ${String(bytes.length)}`);
  }
  return key;
}

/** Gives a text a test uses as a join code, failing the test when it is not one. */
export function testJoinCode(text: string): JoinCode {
  if (!isJoinCode(text)) {
    throw new RangeError(`Not a join code: ${text}`);
  }
  return text;
}

/** Gives a text a test uses as the token of a person, failing the test when it is not one. */
export function testToken(text: string): RejoinToken {
  return requireRejoinToken(text);
}

/** Gives a text a test uses as the digest of a token, failing the test when it is not one. */
export function testDigest(text: string): TokenDigest {
  return requireTokenDigest(text);
}

/** Gives any bytes as the key that checks signatures, unchecked, for tests that show what a forged key would do. */
export function forgedVerifyKey(bytes: Uint8Array): RelayVerifyKey {
  return bytes as RelayVerifyKey;
}
