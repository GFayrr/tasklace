import fc from 'fast-check';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { failure } from '../../result';
import { PROPERTY_TEST_TIMEOUT_MS } from '../../testing/arbitraries';
import { SESSION_ID_BYTES, startHandshake, type Handshake, type SessionKeys } from './cpace';

const SESSION = Uint8Array.from({ length: SESSION_ID_BYTES }, (_unused, index) => index);

/** Returns a source of random bytes that repeats a seed, so that a handshake can be replayed exactly. */
function seeded(seed: number): (count: number) => Uint8Array {
  let next = seed;
  return (count) =>
    Uint8Array.from({ length: count }, () => {
      next = (next * 1_103_515_245 + 12_345) % 2_147_483_648;
      return next % 256;
    });
}

/** Runs a whole handshake between a host and a guest, each with its code, returning the keys of both or why it stopped. */
function handshake(hostCode: string, guestCode: string, seed = 1) {
  const host = startHandshake(hostCode, SESSION, 'host', seeded(seed));
  const guest = startHandshake(guestCode, SESSION, 'guest', seeded(seed + 1));
  return finish(host, guest);
}

/** Exchanges the shares and the proofs of two sides. */
function finish(host: Handshake, guest: Handshake) {
  const hostSide = host.answer(guest.share);
  const guestSide = guest.answer(host.share);
  if (!hostSide.ok || !guestSide.ok) {
    throw new Error('A share was refused');
  }
  return {
    host: hostSide.value.check(guestSide.value.proof),
    guest: guestSide.value.check(hostSide.value.proof),
  };
}

/** Returns the keys of a successful side, failing the test otherwise. */
function keysOf(result: ReturnType<typeof handshake>['host']): SessionKeys {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

describe('the exchange of keys from a join code', () => {
  it('gives both sides the same keys when they share the code, each sending with the key the other receives with', () => {
    const { host, guest } = handshake('K7Q4MZ', 'K7Q4MZ');
    const hostKeys = keysOf(host);
    const guestKeys = keysOf(guest);
    expect([hostKeys.send, hostKeys.receive, hostKeys.resume]).toEqual([
      guestKeys.receive,
      guestKeys.send,
      guestKeys.resume,
    ]);
    expect(new Set([hostKeys.send, hostKeys.receive, hostKeys.resume].map(bytesToHex)).size).toBe(
      3,
    );
    expect(hostKeys.send).toHaveLength(32);
  });

  it('gives the same keys for the same random choices, so that a change of the algorithm cannot pass unnoticed', () => {
    const keys = keysOf(handshake('K7Q4MZ', 'K7Q4MZ', 7).host);
    expect(
      bytesToHex(sha256(Uint8Array.from([...keys.send, ...keys.receive, ...keys.resume]))),
    ).toBe('683a440e869e8932d6ce07855c23928829151d868b82619d97e05c2af5add8e6');
  });

  it('refuses both sides when the codes differ', () => {
    expect(handshake('K7Q4MZ', 'K7Q4MA')).toEqual({
      host: failure('WRONG_CODE'),
      guest: failure('WRONG_CODE'),
    });
  });

  it('refuses a proof that was changed, and one made for another session', () => {
    const host = startHandshake('K7Q4MZ', SESSION, 'host', seeded(1));
    const guest = startHandshake('K7Q4MZ', SESSION, 'guest', seeded(2));
    const hostSide = host.answer(guest.share);
    const guestSide = guest.answer(host.share);
    if (!hostSide.ok || !guestSide.ok) {
      throw new Error('A share was refused');
    }
    const changed = Uint8Array.from(guestSide.value.proof);
    changed[0] = (changed[0] ?? 0) ^ 1;
    expect(hostSide.value.check(changed)).toEqual(failure('WRONG_CODE'));
    const other = startHandshake('K7Q4MZ', Uint8Array.from(SESSION).reverse(), 'guest', seeded(2));
    expect(finish(host, other)).toEqual({
      host: failure('WRONG_CODE'),
      guest: failure('WRONG_CODE'),
    });
  });

  it.each([
    ['too short', new Uint8Array(31)],
    ['too long', new Uint8Array(33)],
    ['the neutral point', new Uint8Array(32)],
    ['no point of the group', new Uint8Array(32).fill(255)],
  ])('refuses a share that is %s', (_label, share) => {
    const host = startHandshake('K7Q4MZ', SESSION, 'host', seeded(1));
    expect(host.answer(share)).toEqual(failure('INVALID_SHARE'));
  });

  it(
    'agrees on the keys exactly when both sides type the same code',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      const code = fc.stringMatching(/^[A-Z2-9]{6}$/);
      fc.assert(
        fc.property(code, code, fc.nat(), (first, second, seed) => {
          const { host, guest } = handshake(first, second, seed);
          expect(host.ok && guest.ok).toBe(first === second);
        }),
        { numRuns: 40 },
      );
    },
  );
});
