import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { forgedVerifyKey } from '../../testing/secrets';
import { seededRandom } from '../../testing/test-crypto';
import {
  drawRelayAccess,
  isSignedBy,
  messageKeyOf,
  readRelayReadKey,
  readSigningSeed,
  readVerifyKey,
  relayKeysOf,
  viewAccessOf,
  type RelayAccess,
} from './relay-keys';

const READ_KEY = readRelayReadKey(new Uint8Array(32).fill(1));
const SEED = readSigningSeed(new Uint8Array(32).fill(2));
const NODE_VERIFY_KEY = '8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394';
const NODE_SIGNATURE =
  '55211d8cb315876bc1a16eb8bc83309b4cff09d80f17fd24ff273d88878dba9eeb2bf417a439ee48a1dccc74883ae73f9e51f3a599fe62a0c7d908066632ca0b';
const ABC = new TextEncoder().encode('abc');

/** Gives the access of the link to edit made of the fixed test keys. */
function editAccess(): RelayAccess {
  if (READ_KEY === null || SEED === null) {
    throw new Error('The test keys do not have the length of keys.');
  }
  return { kind: 'edit', readKey: READ_KEY, seed: SEED };
}

describe('the keys of a plan shared through a relay', () => {
  it('derives the room, the key of the plan and the key that checks signatures as node:crypto does', () => {
    const keys = relayKeysOf(editAccess());
    expect([
      bytesToHex(keys.roomId),
      bytesToHex(keys.encryptionKey),
      bytesToHex(keys.verifyKey),
    ]).toEqual([
      'bb68920555f41e2d294667c989ae41505031aa15e13bec93edfa6119eb42f082',
      '179c7743191893a64655e426046f6483dcdd6dceb57a582316d727d0eb14fe36',
      NODE_VERIFY_KEY,
    ]);
  });

  it('signs as node:crypto does and derives the key of a message from its salt', () => {
    const keys = relayKeysOf(editAccess());
    expect([
      keys.sign === null ? null : bytesToHex(keys.sign(ABC)),
      bytesToHex(messageKeyOf(keys.encryptionKey, new Uint8Array(16).fill(9))),
    ]).toEqual([
      NODE_SIGNATURE,
      'c54d4aa2e48d96b89fd957fca6de9b0f8eea71175b52e982dda7ca837d9133a9',
    ]);
  });

  it('gives the link to view the same room and key, the key that checks signatures and no way to sign', () => {
    const edit = relayKeysOf(editAccess());
    const view = relayKeysOf(viewAccessOf(editAccess()));
    expect([view, viewAccessOf(viewAccessOf(editAccess()))]).toEqual([
      {
        roomId: edit.roomId,
        encryptionKey: edit.encryptionKey,
        verifyKey: edit.verifyKey,
        sign: null,
      },
      viewAccessOf(editAccess()),
    ]);
  });

  it('draws new keys from the random source, each plan in its own room', () => {
    const random = seededRandom(5);
    const first = relayKeysOf(drawRelayAccess(random));
    const second = relayKeysOf(drawRelayAccess(random));
    expect([first.roomId.length, bytesToHex(first.roomId) === bytesToHex(second.roomId)]).toEqual([
      32,
      false,
    ]);
  });

  it('refuses a random source that does not give the length of a key', () => {
    expect(() => drawRelayAccess(() => new Uint8Array(31))).toThrow(
      new RangeError('The random source did not give the length of a key.'),
    );
  });

  it('checks a signature of the bytes with the key of its seed only', () => {
    const keys = relayKeysOf(editAccess());
    const signature = hexToBytes(NODE_SIGNATURE);
    const other = relayKeysOf(drawRelayAccess(seededRandom(3)));
    const changed = Uint8Array.from(signature);
    changed[10] = (changed[10] ?? 0) ^ 1;
    expect([
      isSignedBy(keys.verifyKey, ABC, signature),
      isSignedBy(keys.verifyKey, Uint8Array.of(1), signature),
      isSignedBy(other.verifyKey, ABC, signature),
      isSignedBy(keys.verifyKey, ABC, changed),
      isSignedBy(keys.verifyKey, ABC, signature.subarray(0, 63)),
    ]).toEqual([true, false, false, false, false]);
  });

  it('refuses a key of small order, written another way, off the curve or of another length, which could let a forged signature pass', () => {
    const fieldPrime = hexToBytes(
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    );
    const identity = new Uint8Array(32);
    identity[0] = 1;
    expect(
      [
        new Uint8Array(32),
        identity,
        fieldPrime,
        hexToBytes('0200000000000000000000000000000000000000000000000000000000000000'),
        hexToBytes(NODE_VERIFY_KEY).subarray(0, 31),
      ].map(readVerifyKey),
    ).toEqual([null, null, null, null, null]);
  });

  it('checks signatures strictly, so that the zero signature of a forged zero key never passes as permissive checks let it', () => {
    expect(isSignedBy(forgedVerifyKey(new Uint8Array(32)), ABC, new Uint8Array(64))).toBe(false);
  });

  it('reads keys and seeds of the length of a key only', () => {
    expect([
      readRelayReadKey(new Uint8Array(31)),
      readSigningSeed(new Uint8Array(33)),
      readRelayReadKey(new Uint8Array(32))?.length,
    ]).toEqual([null, null, 32]);
  });
});
