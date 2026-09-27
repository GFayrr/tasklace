import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MAX_SORT_KEY_LENGTH } from '../limits';
import { PROPERTY_TEST_TIMEOUT_MS, unwrap } from '../testing/arbitraries';
import { keyBetween, spreadKeys } from './fractional-index';

const USABLE_KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

const keyArbitrary = fc.stringMatching(/^[0-9A-Za-z]{0,6}[1-9A-Za-z]$/);

/** Returns two different usable keys in increasing order. */
const orderedPairArbitrary = fc
  .tuple(keyArbitrary, keyArbitrary)
  .filter(([left, right]) => left !== right)
  .map(([left, right]): [string, string] => (left < right ? [left, right] : [right, left]));

describe('keyBetween', () => {
  it('returns a key for an empty list and around one key', () => {
    expect(unwrap(keyBetween(null, null))).toMatch(USABLE_KEY);
    expect(unwrap(keyBetween(null, 'V')) < 'V').toBe(true);
    expect(unwrap(keyBetween('V', null)) > 'V').toBe(true);
  });

  it('finds a key between keys that differ only by a trailing digit', () => {
    const key = unwrap(keyBetween('a', 'a1'));
    expect(key > 'a' && key < 'a1').toBe(true);
    expect(key).toMatch(USABLE_KEY);
  });

  it('refuses keys in the wrong order, equal keys and malformed keys', () => {
    expect(keyBetween('b', 'a')).toEqual({ ok: false, error: 'NO_SORT_KEY_BETWEEN' });
    expect(keyBetween('a', 'a')).toEqual({ ok: false, error: 'NO_SORT_KEY_BETWEEN' });
    expect(keyBetween('a0', null)).toEqual({ ok: false, error: 'INVALID_SORT_KEY' });
    expect(keyBetween(null, '')).toEqual({ ok: false, error: 'INVALID_SORT_KEY' });
    expect(keyBetween('a-b', null)).toEqual({ ok: false, error: 'INVALID_SORT_KEY' });
  });

  it('refuses a key that would exceed the maximum length', () => {
    const long = 'a'.repeat(MAX_SORT_KEY_LENGTH);
    expect(keyBetween(long, `${long.slice(0, -1)}b`)).toEqual({
      ok: false,
      error: 'NO_SORT_KEY_BETWEEN',
    });
    let low = 'a';
    let result = keyBetween(low, 'b');
    while (result.ok) {
      low = result.value;
      result = keyBetween(low, 'b');
    }
    expect(result).toEqual({ ok: false, error: 'NO_SORT_KEY_BETWEEN' });
    expect(low.length).toBeLessThanOrEqual(MAX_SORT_KEY_LENGTH);
  });

  it(
    'always returns a usable key strictly between two keys',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(orderedPairArbitrary, ([low, high]) => {
          const key = unwrap(keyBetween(low, high));
          expect(key > low && key < high).toBe(true);
          expect(key).toMatch(USABLE_KEY);
        }),
      );
    },
  );

  it(
    'keeps the order when inserting repeatedly at random places',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(fc.array(fc.nat(), { maxLength: 60 }), (positions) => {
          const keys: string[] = [];
          for (const position of positions) {
            const index = position % (keys.length + 1);
            const key = unwrap(keyBetween(keys[index - 1] ?? null, keys[index] ?? null));
            keys.splice(index, 0, key);
          }
          expect(keys).toEqual([...keys].sort());
          expect(new Set(keys).size).toBe(keys.length);
        }),
      );
    },
  );
});

describe('spreadKeys', () => {
  it.each([0, 1, 2, 61, 62, 1_000, 50_000])('returns %i short increasing keys', (count) => {
    const keys = spreadKeys(count);
    expect(keys).toHaveLength(count);
    expect(keys.every((key) => USABLE_KEY.test(key) && key.length <= 3)).toBe(true);
    expect(keys.every((key, index) => index === 0 || (keys[index - 1] ?? '') < key)).toBe(true);
  });

  it('leaves room before, between and after the keys', () => {
    const [first, second] = spreadKeys(2);
    expect(keyBetween(null, first ?? null).ok).toBe(true);
    expect(keyBetween(first ?? null, second ?? null).ok).toBe(true);
    expect(keyBetween(second ?? null, null).ok).toBe(true);
  });
});
