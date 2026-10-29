import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ROOM_ID_BYTES, SIGNATURE_BYTES, VERIFY_KEY_BYTES } from './relay-wire';

declare const READ_KEY_BRAND: unique symbol;
declare const SIGNING_SEED_BRAND: unique symbol;
declare const VERIFY_KEY_BRAND: unique symbol;
declare const ROOM_ID_BRAND: unique symbol;
declare const ENCRYPTION_KEY_BRAND: unique symbol;

export type RelayReadKey = Uint8Array & { readonly [READ_KEY_BRAND]: true };
export type RelaySigningSeed = Uint8Array & { readonly [SIGNING_SEED_BRAND]: true };
export type RelayVerifyKey = Uint8Array & { readonly [VERIFY_KEY_BRAND]: true };
export type RelayRoomId = Uint8Array & { readonly [ROOM_ID_BRAND]: true };
export type RelayEncryptionKey = Uint8Array & { readonly [ENCRYPTION_KEY_BRAND]: true };

export interface EditRelayAccess {
  readonly kind: 'edit';
  readonly readKey: RelayReadKey;
  readonly seed: RelaySigningSeed;
}

export interface ViewRelayAccess {
  readonly kind: 'view';
  readonly readKey: RelayReadKey;
  readonly verifyKey: RelayVerifyKey;
}

export type RelayAccess = EditRelayAccess | ViewRelayAccess;

interface DerivedRelayKeys {
  readonly roomId: RelayRoomId;
  readonly encryptionKey: RelayEncryptionKey;
  readonly verifyKey: RelayVerifyKey;
}

export interface EditRelayKeys extends DerivedRelayKeys {
  readonly kind: 'edit';
  readonly sign: (bytes: Uint8Array) => Uint8Array;
}

export interface ViewRelayKeys extends DerivedRelayKeys {
  readonly kind: 'view';
  readonly sign: null;
}

export type RelayKeys = EditRelayKeys | ViewRelayKeys;

export const RELAY_KEY_BYTES = 32;

const STRICT = { zip215: false } as const;
const ENCODER = new TextEncoder();
const ROOM_INFO = ENCODER.encode('Tasklace relay room v1');
const ENCRYPTION_INFO = ENCODER.encode('Tasklace relay encryption v1');
const MESSAGE_INFO = ENCODER.encode('Tasklace relay message v1');
const NO_SALT = new Uint8Array();

/** Draws the keys of a new plan shared through a relay: a key to read it and a seed to sign its changes. */
export function drawRelayAccess(randomBytes: (count: number) => Uint8Array): EditRelayAccess {
  const readKey = readRelayReadKey(randomBytes(RELAY_KEY_BYTES));
  const seed = readSigningSeed(randomBytes(RELAY_KEY_BYTES));
  if (readKey === null || seed === null) {
    throw new RangeError('The random source did not give the length of a key.');
  }
  return { kind: 'edit', readKey, seed };
}

/** Gives the access of the link to view a plan from the access of the link to edit it: the same key to read, and the key that checks signatures instead of the seed that makes them. */
export function viewAccessOf(access: RelayAccess): ViewRelayAccess {
  return access.kind === 'view'
    ? access
    : { kind: 'view', readKey: access.readKey, verifyKey: verifyKeyOf(access.seed) };
}

export function relayKeysOf(access: EditRelayAccess): EditRelayKeys;
export function relayKeysOf(access: ViewRelayAccess): ViewRelayKeys;
export function relayKeysOf(access: RelayAccess): RelayKeys;
/** Derives what a member needs from its access: the room on the relay, the key that encrypts the plan, the key that checks signatures and, with the link to edit, how to sign. */
export function relayKeysOf(access: RelayAccess): RelayKeys {
  const roomId = derived(access.readKey, ROOM_INFO, ROOM_ID_BYTES, isRoomId);
  const encryptionKey = derived(access.readKey, ENCRYPTION_INFO, RELAY_KEY_BYTES, isEncryptionKey);
  if (access.kind === 'view') {
    return { kind: 'view', roomId, encryptionKey, verifyKey: access.verifyKey, sign: null };
  }
  const { seed } = access;
  return {
    kind: 'edit',
    roomId,
    encryptionKey,
    verifyKey: verifyKeyOf(seed),
    sign: (bytes) => ed25519.sign(bytes, seed),
  };
}

/** Derives a key of some length from the key that reads a plan under the name of its use, so that the keys of two uses never meet. */
function derived<Key extends Uint8Array>(
  readKey: RelayReadKey,
  info: Uint8Array,
  length: number,
  isKey: (bytes: Uint8Array) => bytes is Key,
): Key {
  const key = hkdf(sha256, readKey, NO_SALT, info, length);
  if (!isKey(key)) {
    throw new RangeError('A key was derived with a length of another use.');
  }
  return key;
}

/** Tells whether bytes have the length of the identifier of a room on the relay. */
function isRoomId(bytes: Uint8Array): bytes is RelayRoomId {
  return bytes.length === ROOM_ID_BYTES;
}

/** Tells whether bytes have the length of the key that encrypts a plan. */
function isEncryptionKey(bytes: Uint8Array): bytes is RelayEncryptionKey {
  return bytes.length === RELAY_KEY_BYTES;
}

/** Derives the key of one message from the key of the plan and the random salt of that message, so that no two messages ever share a key. */
export function messageKeyOf(encryptionKey: RelayEncryptionKey, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, encryptionKey, salt, MESSAGE_INFO, RELAY_KEY_BYTES);
}

/** Tells whether a signature of bytes was made with the seed of a key, checked strictly so that no key or signature of small order passes. */
export function isSignedBy(
  verifyKey: RelayVerifyKey,
  bytes: Uint8Array,
  signature: Uint8Array,
): boolean {
  return (
    signature.length === SIGNATURE_BYTES && ed25519.verify(signature, bytes, verifyKey, STRICT)
  );
}

/** Reads the key that reads a plan from bytes, or returns null when they do not have its length. */
export function readRelayReadKey(bytes: Uint8Array): RelayReadKey | null {
  return isReadKey(bytes) ? bytes : null;
}

/** Tells whether bytes have the length of the key that reads a plan. */
function isReadKey(bytes: Uint8Array): bytes is RelayReadKey {
  return bytes.length === RELAY_KEY_BYTES;
}

/** Reads the seed that signs the changes of a plan from bytes, or returns null when they do not have its length. */
export function readSigningSeed(bytes: Uint8Array): RelaySigningSeed | null {
  return isSigningSeed(bytes) ? bytes : null;
}

/** Tells whether bytes have the length of the seed that signs the changes of a plan. */
function isSigningSeed(bytes: Uint8Array): bytes is RelaySigningSeed {
  return bytes.length === RELAY_KEY_BYTES;
}

/** Reads the key that checks signatures from bytes, or returns null for bytes that are not a point of the curve written the one canonical way, or a point of small order, which would let a forged signature pass. */
export function readVerifyKey(bytes: Uint8Array): RelayVerifyKey | null {
  return isVerifyKey(bytes) ? bytes : null;
}

/** Tells whether bytes are a point of the curve of large order written the one canonical way. */
function isVerifyKey(bytes: Uint8Array): bytes is RelayVerifyKey {
  if (bytes.length !== VERIFY_KEY_BYTES) {
    return false;
  }
  try {
    return !ed25519.Point.fromBytes(bytes, STRICT.zip215).isSmallOrder();
  } catch (error) {
    if (error instanceof Error) {
      return false;
    }
    throw error;
  }
}

/** Gives the key that checks the signatures a seed makes. */
function verifyKeyOf(seed: RelaySigningSeed): RelayVerifyKey {
  const key = readVerifyKey(ed25519.getPublicKey(seed));
  if (key === null) {
    throw new RangeError('A seed gave a key that cannot check signatures.');
  }
  return key;
}
