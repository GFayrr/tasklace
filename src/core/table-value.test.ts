import { describe, expect, it } from 'vitest';
import { valueAt } from './table-value';

describe('valueAt', () => {
  it('returns the value at a position of a table, including zero', () => {
    expect(valueAt([4, 0, 9], 1)).toBe(0);
    expect(valueAt(Int32Array.from([7, 8]), 1)).toBe(8);
    expect(valueAt([[1, 2]], 0)).toEqual([1, 2]);
  });

  it('throws for a position outside the table instead of giving a wrong value', () => {
    expect(() => valueAt([1, 2], 2)).toThrow(
      new RangeError('No value at position 2 of a table of 2.'),
    );
    expect(() => valueAt([1, 2], -1)).toThrow(RangeError);
    expect(() => valueAt(Int32Array.from([1]), 0.5)).toThrow(RangeError);
  });
});
