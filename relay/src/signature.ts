import { createPublicKey, verify } from 'node:crypto';
import {
  SIGNATURE_BYTES,
  VERIFY_KEY_BYTES,
} from '../../src/core/collaboration/relay/relay-wire.ts';

export type Verifier = (bytes: Uint8Array, signature: Uint8Array) => boolean;

/** Gives what checks Ed25519 signatures against a verify key, or null for bytes that are not the length of a key, any other bytes being taken and simply never matching a signature. */
export function verifierOf(verifyKey: Uint8Array): Verifier | null {
  if (verifyKey.length !== VERIFY_KEY_BYTES) {
    return null;
  }
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(verifyKey).toString('base64url') },
    format: 'jwk',
  });
  return (bytes, signature) =>
    signature.length === SIGNATURE_BYTES && verify(null, bytes, key, signature);
}
