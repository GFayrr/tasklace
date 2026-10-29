import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawRelayAccess, readVerifyKey, relayKeysOf, viewAccessOf } from './relay-keys';

const broken = vi.hoisted(() => ({
  shortDerivation: false,
  smallOrderPublicKey: false,
  pointThrowsText: false,
}));

vi.mock('@noble/hashes/hkdf.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@noble/hashes/hkdf.js')>();
  return {
    ...original,
    hkdf: (...args: Parameters<typeof original.hkdf>) =>
      broken.shortDerivation ? new Uint8Array(1) : original.hkdf(...args),
  };
});

vi.mock('@noble/curves/ed25519.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@noble/curves/ed25519.js')>();
  const point = original.ed25519.Point;
  return {
    ed25519: {
      ...original.ed25519,
      getPublicKey: (...args: Parameters<typeof original.ed25519.getPublicKey>) =>
        broken.smallOrderPublicKey
          ? new Uint8Array(32).fill(0).with(0, 1)
          : original.ed25519.getPublicKey(...args),
      Point: {
        fromBytes: (...args: Parameters<typeof point.fromBytes>) => {
          if (broken.pointThrowsText) {
            const failure: unknown = 'not an error';
            throw failure;
          }
          return point.fromBytes(...args);
        },
      },
    },
  };
});

afterEach(() => {
  Object.assign(broken, {
    shortDerivation: false,
    smallOrderPublicKey: false,
    pointThrowsText: false,
  });
});

/** Draws the access of a link to edit from fixed bytes. */
function access(): ReturnType<typeof drawRelayAccess> {
  return drawRelayAccess((count) => new Uint8Array(count).fill(7));
}

describe('keys of a relay whose cryptography misbehaves', () => {
  it('throws rather than use a key derived with the length of another use', () => {
    const drawn = access();
    broken.shortDerivation = true;
    expect(() => relayKeysOf(drawn)).toThrow(
      new RangeError('A key was derived with a length of another use.'),
    );
  });

  it('throws rather than use a seed whose key cannot check signatures', () => {
    const drawn = access();
    broken.smallOrderPublicKey = true;
    expect(() => viewAccessOf(drawn)).toThrow(
      new RangeError('A seed gave a key that cannot check signatures.'),
    );
  });

  it('lets a value thrown while reading a key that is not an error through', () => {
    broken.pointThrowsText = true;
    expect(() => readVerifyKey(new Uint8Array(32))).toThrow('not an error');
  });
});
