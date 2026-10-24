import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, equalBytes } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { failure, success, type Result } from '../../result';

export type HandshakeRole = 'host' | 'guest';

export interface SessionKeys {
  readonly send: Uint8Array;
  readonly receive: Uint8Array;
  readonly resume: Uint8Array;
}

export interface Handshake {
  readonly share: Uint8Array;
  readonly answer: (peerShare: Uint8Array) => Result<Confirmation, 'INVALID_SHARE'>;
}

export interface Confirmation {
  readonly proof: Uint8Array;
  readonly check: (peerProof: Uint8Array) => Result<SessionKeys, 'WRONG_PASSWORD'>;
}

export const SESSION_ID_BYTES = 32;
export const SHARE_BYTES = 32;

const DOMAIN = 'Tasklace CPace ristretto255 v1';
const GENERATOR_DOMAIN = `${DOMAIN} generator`;
const KEY_DOMAIN = `${DOMAIN} key`;
const SCALAR_SEED_BYTES = 64;
const KEY_BYTES = 32;
const LENGTH_PREFIX_BYTES = 2;
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;
const ENCODER = new TextEncoder();
const LABELS = {
  confirm: 'confirm',
  hostProof: 'host proof',
  guestProof: 'guest proof',
  hostToGuest: 'host to guest',
  guestToHost: 'guest to host',
  resume: 'resume',
} as const;

/** Starts the exchange of keys from a password, a join code or the key of a plan (CPace on ristretto255), both sides share a random multiple of a generator derived from the password and the session, so only those knowing it get the same secret. */
export function startHandshake(
  password: string,
  sessionId: Uint8Array,
  role: HandshakeRole,
  randomBytes: (count: number) => Uint8Array,
): Handshake {
  const generator = ristretto255_hasher.hashToCurve(
    withLengths([ENCODER.encode(password), sessionId]),
    { DST: GENERATOR_DOMAIN },
  );
  const secret = randomScalar(randomBytes);
  const share = generator.multiply(secret).toBytes();
  return {
    share,
    answer: (peerShare) => {
      const peer = readShare(peerShare);
      if (peer === null) {
        return failure('INVALID_SHARE');
      }
      const shared = peer.multiply(secret);
      const [hostShare, guestShare] = role === 'host' ? [share, peerShare] : [peerShare, share];
      const transcript = withLengths([sessionId, shared.toBytes(), hostShare, guestShare]);
      return success(
        confirmationOf(sha512(withLengths([ENCODER.encode(KEY_DOMAIN), transcript])), {
          sessionId,
          transcript,
          role,
        }),
      );
    },
  };
}

/** Builds the proof that this side knows the password and the check of the proof of the other side, the keys being given only when that proof matches. */
function confirmationOf(
  secret: Uint8Array,
  context: {
    readonly sessionId: Uint8Array;
    readonly transcript: Uint8Array;
    readonly role: HandshakeRole;
  },
): Confirmation {
  const { sessionId, transcript, role } = context;
  /** Derives a key of the session for one use. */
  const derive = (label: string): Uint8Array =>
    hkdf(sha256, secret, sessionId, ENCODER.encode(label), KEY_BYTES);
  const confirmKey = derive(LABELS.confirm);
  /** Proves knowledge of the shared secret for one side. */
  const proofOf = (side: HandshakeRole): Uint8Array =>
    hmac(
      sha512,
      confirmKey,
      withLengths([
        ENCODER.encode(side === 'host' ? LABELS.hostProof : LABELS.guestProof),
        transcript,
      ]),
    );
  const peerRole: HandshakeRole = role === 'host' ? 'guest' : 'host';
  return {
    proof: proofOf(role),
    check: (peerProof) => {
      if (!equalBytes(peerProof, proofOf(peerRole))) {
        return failure('WRONG_PASSWORD');
      }
      const hostToGuest = derive(LABELS.hostToGuest);
      const guestToHost = derive(LABELS.guestToHost);
      return success({
        send: role === 'host' ? hostToGuest : guestToHost,
        receive: role === 'host' ? guestToHost : hostToGuest,
        resume: derive(LABELS.resume),
      });
    },
  };
}

/** Draws a random scalar of the group from more random bytes than the order needs so that it carries no bias, drawing again in the negligible case of zero. */
function randomScalar(randomBytes: (count: number) => Uint8Array): bigint {
  const field = ristretto255.Point.Fn;
  const scalar = field.create(bytesToNumberLE(randomBytes(SCALAR_SEED_BYTES)));
  return field.isValidNot0(scalar) ? scalar : randomScalar(randomBytes);
}

/** Reads the share of the other side, or returns null for bytes that are not the canonical encoding of a point other than the neutral one, which keeps the shared secret from ever being neutral in this group of prime order. */
function readShare(bytes: Uint8Array): ReturnType<typeof ristretto255.Point.fromBytes> | null {
  if (bytes.length !== SHARE_BYTES) {
    return null;
  }
  try {
    const point = ristretto255.Point.fromBytes(bytes);
    return point.is0() ? null : point;
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }
    throw error;
  }
}

/** Joins byte strings, each preceded by its length on two bytes, so that no two different lists give the same bytes. */
function withLengths(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + LENGTH_PREFIX_BYTES + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined[at] = (part.length >> BYTE_BITS) & BYTE_MASK;
    joined[at + 1] = part.length & BYTE_MASK;
    joined.set(part, at + LENGTH_PREFIX_BYTES);
    at += LENGTH_PREFIX_BYTES + part.length;
  }
  return joined;
}
