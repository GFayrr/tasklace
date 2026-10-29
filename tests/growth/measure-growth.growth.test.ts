import { describe, expect, it } from 'vitest';
import {
  batched,
  growthRatio,
  growthRatioOf,
  LINEAR_MAX_RATIO,
  SIZE_FACTOR,
} from './measure-growth';

const SMALL_SIZE = 3_000;
const LARGE_SIZE = SMALL_SIZE * SIZE_FACTOR;

/** Sums the pairs of an array one by one, a deliberately quadratic operation. */
function sumAllPairs(values: readonly number[]): number {
  let total = 0;
  for (const left of values) {
    for (const right of values) {
      total += left * right;
    }
  }
  return total;
}

/** Sums an array once, a linear operation. */
function sumOnce(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('growth measurement', () => {
  const small = Array.from({ length: SMALL_SIZE }, (_unused, index) => index);
  const large = Array.from({ length: LARGE_SIZE }, (_unused, index) => index);

  it('lets a linear operation through', () => {
    const ratio = growthRatio(
      batched(200, () => sumOnce(small)),
      batched(200, () => sumOnce(large)),
    );
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('catches a quadratic operation', () => {
    const ratio = growthRatio(
      () => sumAllPairs(small),
      () => sumAllPairs(large),
    );
    expect(ratio).toBeGreaterThan(LINEAR_MAX_RATIO);
  });

  it('lets a linear asynchronous operation through and catches a quadratic one', async () => {
    /** Runs an operation after the current work of the event loop, as an asynchronous one does. */
    const later = (operation: () => void) => async (): Promise<void> => {
      await Promise.resolve();
      operation();
    };
    const ratios = [
      await growthRatioOf(
        later(batched(200, () => sumOnce(small))),
        later(batched(200, () => sumOnce(large))),
      ),
      await growthRatioOf(
        later(() => sumAllPairs(small)),
        later(() => sumAllPairs(large)),
      ),
    ];
    expect(ratios.map((ratio) => ratio <= LINEAR_MAX_RATIO)).toEqual([true, false]);
  });
});
