import { describe, expect, it } from 'vitest';
import { createAddressBuckets, createBucket } from './rate.ts';

describe('a bucket of tokens', () => {
  it('gives its burst at once, then one token for each share of a second gone by, never more than its burst', () => {
    let time = 0;
    const take = createBucket({ perSecond: 2, burst: 3 }, () => time);
    const burst = [take(), take(), take(), take()];
    time = 499;
    const early = take();
    time = 500;
    const refilled = [take(), take()];
    time = 100_000;
    const capped = [take(), take(), take(), take()];
    expect([burst, early, refilled, capped]).toEqual([
      [true, true, true, false],
      false,
      [true, false],
      [true, true, true, false],
    ]);
  });

  it('never gains tokens from a clock that went back', () => {
    let time = 1_000;
    const take = createBucket({ perSecond: 1, burst: 1 }, () => time);
    take();
    time = 0;
    expect(take()).toBe(false);
  });

  it('keeps one bucket for each address, forgetting the one seen least recently once too many are kept', () => {
    const take = createAddressBuckets({ perSecond: 0, burst: 1 }, 2, () => 0);
    const first = [take('a'), take('a'), take('b'), take('a')];
    const third = take('c');
    const forgotten = take('b');
    expect([first, third, forgotten]).toEqual([[true, false, true, false], true, true]);
  });
});
